const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    AttachmentBuilder
} = require('discord.js');
const express = require('express');
require('dotenv').config();

// 1. Keep-Alive Web Server
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Keep-alive server running.'));

// 2. Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel, Partials.Message]
});

// In-Memory Database Stores
const tempAnnounceData = new Map();
const tokenGuildConfigs = new Map();
const blacklistedUsers = new Set();
const userActiveTickets = new Map(); // userId -> activeTicketChannelId
const ticketStats = new Map(); // staffId -> resolvedCount
let globalTicketCounter = 1; // Sequential Counter (0001, 0002, etc.)

// 3. Register Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Open announcement editor!')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption(opt => opt.setName('channel').setDescription('Target Channel').setRequired(true))
        .addBooleanOption(opt => opt.setName('dm').setDescription('Send to all member DMs? (Optional)'))
        .addStringOption(opt => opt.setName('title').setDescription('Embed Title (Optional)'))
        .addStringOption(opt => opt.setName('color').setDescription('Hex Color e.g. #FF0000 (Optional)'))
        .addStringOption(opt => opt.setName('author_name').setDescription('Author Header Name (Optional)'))
        .addStringOption(opt => opt.setName('author_icon').setDescription('Author Icon URL (Optional)'))
        .addStringOption(opt => opt.setName('thumbnail').setDescription('Thumbnail Image URL (Optional)'))
        .addStringOption(opt => opt.setName('field1_title').setDescription('Field 1 Title (Optional)'))
        .addStringOption(opt => opt.setName('field2_title').setDescription('Field 2 Title (Optional)'))
        .addStringOption(opt => opt.setName('field3_title').setDescription('Field 3 Title (Optional)'))
        .addStringOption(opt => opt.setName('footer_text').setDescription('Footer Text (Optional)'))
        .addStringOption(opt => opt.setName('footer_icon').setDescription('Footer Icon URL (Optional)')),

    // --- FULL R.O.T.I HELP DESK COMMANDS ---
    new SlashCommandBuilder()
        .setName('token-setup')
        .setDescription('Send the interactive R.O.T.I ticket panel to a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel for the panel').setRequired(true))
        .addRoleOption(opt => opt.setName('support_role').setDescription('Staff role for isolation').setRequired(true))
        .addChannelOption(opt => opt.setName('category').setDescription('Category for ticket channels').addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption(opt => opt.setName('logs_channel').setDescription('Channel for ticket transcripts').addChannelTypes(ChannelType.GuildText)),

    new SlashCommandBuilder()
        .setName('ticket-add')
        .setDescription('Add a user to this active ticket')
        .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ticket-remove')
        .setDescription('Remove a user from this active ticket')
        .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ticket-rename')
        .setDescription('Rename the active ticket channel')
        .addStringOption(opt => opt.setName('name').setDescription('New channel name').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ticket-close')
        .setDescription('Close and lock the current ticket')
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for closure')),

    new SlashCommandBuilder()
        .setName('ticket-reopen')
        .setDescription('Reopen a closed ticket'),

    new SlashCommandBuilder()
        .setName('ticket-delete')
        .setDescription('Delete channel and post official transcript log')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('ticket-transcript')
        .setDescription('Generate full transcript of this support session'),

    new SlashCommandBuilder()
        .setName('ticket-claim')
        .setDescription('Claim this ticket as staff'),

    new SlashCommandBuilder()
        .setName('ticket-blacklist')
        .setDescription('Toggle blacklist status for a user')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(opt => opt.setName('user').setDescription('User to toggle').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ticket-stats')
        .setDescription('View support staff performance leaderboard')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
].map(cmd => cmd.toJSON());

// 4. Client Ready Event
client.once('clientReady', async () => {
    console.log(`LoggedIn as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const GUILD_ID = '1532296511096885378';

    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log(`R.O.T.I Module registered to Guild: ${GUILD_ID}`);
    } catch (err) {
        console.error('Error registering commands:', err);
    }
});

// Helper: Transcript Generator
async function generateTranscript(channel) {
    let messages = [];
    let lastId;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;
        const fetched = await channel.messages.fetch(options);
        messages.push(...fetched.values());
        if (fetched.size < 100) break;
        lastId = fetched.last().id;
    }

    messages.reverse();

    let transcriptText = `==================================================\n`;
    transcriptText += `R.O.T.I OFFICIAL TRANSCRIPT: #${channel.name}\n`;
    transcriptText += `DATE: ${new Date().toUTCString()}\n`;
    transcriptText += `==================================================\n\n`;

    messages.forEach(msg => {
        const timestamp = msg.createdAt.toISOString().replace('T', ' ').substring(0, 19);
        const author = `${msg.author.tag} (${msg.author.id})`;
        const content = msg.content || (msg.embeds.length > 0 ? '[Embed Content]' : '[Attachment]');
        
        transcriptText += `[${timestamp}] ${author}:\n${content}\n`;
        if (msg.attachments.size > 0) {
            msg.attachments.forEach(att => {
                transcriptText += `[Attachment]: ${att.url}\n`;
            });
        }
        transcriptText += `--------------------------------------------------\n`;
    });

    const buffer = Buffer.from(transcriptText, 'utf-8');
    return new AttachmentBuilder(buffer, { name: `transcript-${channel.name}.txt` });
}

// Helper: Purge & Log Session
async function purgeTicketSession(channel, closedBy, reason = 'No reason provided') {
    const guild = channel.guild;
    const config = tokenGuildConfigs.get(guild.id) || {};
    const attachment = await generateTranscript(channel);

    let tokenOpener = null;
    try {
        const firstMsg = (await channel.messages.fetch({ limit: 10, oldest: true })).first();
        if (firstMsg && firstMsg.mentions.users.size > 0) {
            tokenOpener = firstMsg.mentions.users.first();
        }
    } catch (e) {}

    if (closedBy && !closedBy.bot) {
        const currentCount = ticketStats.get(closedBy.id) || 0;
        ticketStats.set(closedBy.id, currentCount + 1);
    }

    if (tokenOpener) {
        userActiveTickets.delete(tokenOpener.id);
    }

    const logEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🔒 Ticket Closed & Archived')
        .addFields(
            { name: '📁 Ticket Channel', value: `\`${channel.name}\``, inline: true },
            { name: '👤 Closed By', value: `${closedBy}`, inline: true },
            { name: '👤 Ticket Owner', value: tokenOpener ? `${tokenOpener}` : 'Unknown', inline: true },
            { name: '📝 Reason', value: `\`\`\`${reason}\`\`\``, inline: false }
        )
        .setTimestamp();

    if (tokenOpener) {
        try {
            await tokenOpener.send({
                content: `📄 Official transcript log for your ticket in **${guild.name}**:`,
                embeds: [logEmbed],
                files: [attachment]
            });
        } catch (e) {}
    }

    if (config.logsChannelId) {
        const logsChannel = guild.channels.cache.get(config.logsChannelId);
        if (logsChannel) {
            try {
                await logsChannel.send({ embeds: [logEmbed], files: [attachment] });
            } catch (e) {}
        }
    }

    setTimeout(() => channel.delete().catch(() => {}), 3000);
}

// Helper: Create Sequential Ticket Channel
async function createTokenChannel(interaction, categoryValue, reason) {
    const guild = interaction.guild;
    const user = interaction.user;

    // Abuse Check 1: Blacklist
    if (blacklistedUsers.has(user.id)) {
        return interaction.reply({ content: '❌ You are blacklisted from opening support tickets.', ephemeral: true });
    }

    // Abuse Check 2: Ticket Limit
    if (userActiveTickets.has(user.id)) {
        const existingChannelId = userActiveTickets.get(user.id);
        if (guild.channels.cache.has(existingChannelId)) {
            return interaction.reply({ content: `❌ You already have an active ticket open: <#${existingChannelId}>.`, ephemeral: true });
        }
    }

    const config = tokenGuildConfigs.get(guild.id) || {};
    const supportRoleId = config.supportRoleId;
    const categoryId = config.categoryId;

    let supportRole = supportRoleId ? guild.roles.cache.get(supportRoleId) : null;
    if (!supportRole) {
        supportRole = guild.roles.cache.find(r => r.name.toLowerCase().includes('support') || r.name.toLowerCase().includes('staff')) || guild.roles.everyone;
    }

    let category = categoryId ? guild.channels.cache.get(categoryId) : null;

    // Sequential ID generation: ticket-0001, ticket-0002, etc.
    const formattedId = String(globalTicketCounter++).padStart(4, '0');
    const channelName = `ticket-${formattedId}`;

    try {
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category ? category.id : null,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
                { id: supportRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] }
            ]
        });

        userActiveTickets.set(user.id, channel.id);

        const rotiEmbed = new EmbedBuilder()
            .setColor('#2F3136')
            .setTitle(`🎟️ Help Desk | ${categoryValue.toUpperCase()}`)
            .setDescription(`Welcome ${user}! Support staff will be with you shortly.\n\nUse the buttons below to manage this session.`)
            .addFields(
                { name: '👤 Opened By', value: `${user}`, inline: true },
                { name: '📌 Category', value: `\`${categoryValue}\``, inline: true },
                { name: '📝 Reason / Subject', value: `\`\`\`${reason}\`\`\``, inline: false }
            )
            .setFooter({ text: `Ticket ID: #${formattedId} • R.O.T.I Help Desk`, iconURL: guild.iconURL() || undefined })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('token_close_btn').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('token_claim_btn').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋‍♂️'),
            new ButtonBuilder().setCustomId('token_transcript_btn').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄')
        );

        await channel.send({ content: `${user} | ${supportRole}`, embeds: [rotiEmbed], components: [row] });
        await interaction.reply({ content: `✅ Ticket created! Head over to ${channel}`, ephemeral: true });
    } catch (err) {
        console.error('Error creating ticket channel:', err);
        await interaction.reply({ content: '❌ Failed to create ticket channel.', ephemeral: true });
    }
}

// 5. Interaction Router
client.on('interactionCreate', async (interaction) => {

    // --- Command: /announce ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
        const hasPerms = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
        if (!hasPerms) return interaction.reply({ content: '❌ Invalid permissions!', ephemeral: true });

        tempAnnounceData.set(interaction.user.id, {
            channelId: interaction.options.getChannel('channel').id,
            sendDM: interaction.options.getBoolean('dm') || false,
            title: interaction.options.getString('title'),
            color: interaction.options.getString('color') || '#FFD700',
            authorName: interaction.options.getString('author_name'),
            authorIcon: interaction.options.getString('author_icon'),
            thumbnail: interaction.options.getString('thumbnail'),
            field1Title: interaction.options.getString('field1_title'),
            field2Title: interaction.options.getString('field2_title'),
            field3Title: interaction.options.getString('field3_title'),
            footerText: interaction.options.getString('footer_text'),
            footerIcon: interaction.options.getString('footer_icon')
        });

        const modal = new ModalBuilder().setCustomId('announceModal').setTitle('Announcement Builder');
        modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('descInput').setLabel("Description").setStyle(TextInputStyle.Paragraph).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('field1Input').setLabel("Field 1 (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('field2Input').setLabel("Field 2 (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('field3Input').setLabel("Field 3 (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('imageInput').setLabel("Image URL (Optional)").setStyle(TextInputStyle.Short).setRequired(false))
        );
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'announceModal') {
        await interaction.deferReply({ ephemeral: true });
        const options = tempAnnounceData.get(interaction.user.id);
        if (!options) return interaction.editReply('Session expired.');

        const targetChannel = interaction.guild.channels.cache.get(options.channelId);
        const description = interaction.fields.getTextInputValue('descInput');
        const embed = new EmbedBuilder().setDescription(description).setColor(options.color.startsWith('#') ? options.color : `#${options.color}`);

        if (options.title) embed.setTitle(options.title);
        if (targetChannel) {
            await targetChannel.send({ embeds: [embed] });
            await interaction.editReply('Announcement posted!');
        }
    }

    // --- Panel Creation ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'token-setup') {
        const targetChannel = interaction.options.getChannel('channel');
        const supportRole = interaction.options.getRole('support_role');
        const categoryChannel = interaction.options.getChannel('category');
        const logsChannel = interaction.options.getChannel('logs_channel');

        tokenGuildConfigs.set(interaction.guild.id, {
            supportRoleId: supportRole.id,
            categoryId: categoryChannel ? categoryChannel.id : null,
            logsChannelId: logsChannel ? logsChannel.id : null
        });

        const panelEmbed = new EmbedBuilder()
            .setColor('#2B2D31')
            .setTitle('📩 Support Ticket Portal')
            .setDescription('Need assistance, have an inquiry, or want to submit a request?\n\nSelect a category from the dropdown menu below to open a ticket.')
            .addFields(
                { name: '⚙️ General Support', value: 'Questions regarding the server, account, or rules.', inline: true },
                { name: '🐛 Bug / Technical', value: 'Report bugs or tech glitches.', inline: true },
                { name: '💼 Billing / Donator', value: 'Assistance with store items or perks.', inline: true }
            )
            .setFooter({ text: 'R.O.T.I Token Module • Select below to proceed', iconURL: interaction.guild.iconURL() || undefined });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('token_category_select')
            .setPlaceholder('Select category...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('General Support').setValue('general').setEmoji('⚙️'),
                new StringSelectMenuOptionBuilder().setLabel('Bug / Technical Report').setValue('bug').setEmoji('🐛'),
                new StringSelectMenuOptionBuilder().setLabel('Billing / Donator Request').setValue('billing').setEmoji('💼')
            );

        await targetChannel.send({ embeds: [panelEmbed], components: [new ActionRowBuilder().addComponents(selectMenu)] });
        await interaction.reply({ content: `✅ Ticket panel posted to ${targetChannel}!`, ephemeral: true });
    }

    // --- Category Selection ---
    if (interaction.isStringSelectMenu() && interaction.customId === 'token_category_select') {
        const selectedCategory = interaction.values[0];
        const modal = new ModalBuilder().setCustomId(`token_create_modal_${selectedCategory}`).setTitle('Open Support Ticket');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('token_reason').setLabel('Reason / Topic').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('token_create_modal_')) {
        const categoryValue = interaction.customId.replace('token_create_modal_', '');
        const reason = interaction.fields.getTextInputValue('token_reason');
        await createTokenChannel(interaction, categoryValue, reason);
    }

    // --- Ticket Buttons ---
    if (interaction.isButton()) {
        if (interaction.customId === 'token_close_btn') {
            await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription('🔒 **Ticket Closed.** Staff can reopen with `/ticket-reopen` or delete with `/ticket-delete`.')] });
        }

        if (interaction.customId === 'token_claim_btn') {
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`🙋‍♂️ Ticket claimed by ${interaction.user}!`)] });
        }

        if (interaction.customId === 'token_transcript_btn') {
            await interaction.deferReply();
            const attachment = await generateTranscript(interaction.channel);
            await interaction.editReply({ content: '📄 Ticket transcript generated:', files: [attachment] });
        }
    }

    // --- Chat Commands ---
    if (interaction.isChatInputCommand()) {
        const { commandName, channel, options } = interaction;

        if (commandName === 'ticket-add') {
            const targetUser = options.getUser('user');
            await channel.permissionOverwrites.edit(targetUser.id, { ViewChannel: true, SendMessages: true });
            await interaction.reply({ content: `✅ Added ${targetUser} to the ticket.` });
        }

        if (commandName === 'ticket-remove') {
            const targetUser = options.getUser('user');
            await channel.permissionOverwrites.edit(targetUser.id, { ViewChannel: false });
            await interaction.reply({ content: `🚫 Removed ${targetUser} from the ticket.` });
        }

        if (commandName === 'ticket-rename') {
            const newName = options.getString('name');
            await channel.setName(newName);
            await interaction.reply({ content: `📝 Channel renamed to \`${newName}\`.` });
        }

        if (commandName === 'ticket-close') {
            const reason = options.getString('reason') || 'No reason provided';
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription(`🔒 Ticket closed: **${reason}**`)] });
        }

        if (commandName === 'ticket-reopen') {
            await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription('🔓 Ticket reopened!')] });
        }

        if (commandName === 'ticket-delete') {
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription('🗑️ Archiving and deleting channel...')] });
            await purgeTicketSession(channel, interaction.user);
        }

        if (commandName === 'ticket-transcript') {
            await interaction.deferReply();
            const attachment = await generateTranscript(channel);
            await interaction.editReply({ content: '📄 Here is the full chat transcript:', files: [attachment] });
        }

        if (commandName === 'ticket-blacklist') {
            const user = options.getUser('user');
            if (blacklistedUsers.has(user.id)) {
                blacklistedUsers.delete(user.id);
                await interaction.reply({ content: `✅ Removed ${user} from the blacklist.` });
            } else {
                blacklistedUsers.add(user.id);
                await interaction.reply({ content: `🚫 ${user} is now blacklisted from creating tickets.` });
            }
        }

        if (commandName === 'ticket-stats') {
            let leaderboard = '🏆 **Support Staff Leaderboard**\n\n';
            if (ticketStats.size === 0) {
                leaderboard += 'No tickets resolved yet.';
            } else {
                ticketStats.forEach((count, staffId) => {
                    leaderboard += `<@${staffId}>: **${count}** resolved tickets\n`;
                });
            }
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setDescription(leaderboard)] });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
