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

const tempAnnounceData = new Map();
const autoResponders = new Map();
const tokenGuildConfigs = new Map(); // Stores guild-specific setup configs

function isValidUrl(urlString) {
    if (!urlString) return false;
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// 3. Register Slash Commands
const commands = [
    new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Open announcement editor!')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addChannelOption(opt => opt.setName('channel').setDescription('Target Channel').setRequired(true))
        .addBooleanOption(opt => opt.setName('dm').setDescription('Send to all member DMs? (Optional)'))
        .addStringOption(opt => opt.setName('title').setDescription('Embed Title (Optional)'))
        .addStringOption(opt => opt.setName('color').setDescription('Hex Color e.g. #FF0000 or #00FF88 (Optional)'))
        .addStringOption(opt => opt.setName('author_name').setDescription('Author Header Name (Optional)'))
        .addStringOption(opt => opt.setName('author_icon').setDescription('Author Icon URL (Optional)'))
        .addStringOption(opt => opt.setName('thumbnail').setDescription('Thumbnail Image URL at top right (Optional)'))
        .addStringOption(opt => opt.setName('field1_title').setDescription('Field 1 Header Title (Optional)'))
        .addStringOption(opt => opt.setName('field2_title').setDescription('Field 2 Header Title (Optional)'))
        .addStringOption(opt => opt.setName('field3_title').setDescription('Field 3 Header Title (Optional)'))
        .addStringOption(opt => opt.setName('footer_text').setDescription('Footer Text at bottom (Optional)'))
        .addStringOption(opt => opt.setName('footer_icon').setDescription('Footer Small Icon URL (Optional)')),

    new SlashCommandBuilder()
        .setName('autorespond')
        .setDescription('Set up an automatic reply trigger')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption(opt => opt.setName('trigger').setDescription('Word/phrase to listen for').setRequired(true))
        .addStringOption(opt => opt.setName('reply').setDescription('Bot response').setRequired(true)),

    // --- R.O.T.I Style Token System Commands ---
    new SlashCommandBuilder()
        .setName('token-setup')
        .setDescription('Send the R.O.T.I style token creation panel to a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post the panel in').setRequired(true))
        .addRoleOption(opt => opt.setName('support_role').setDescription('Role that manages tokens').setRequired(true))
        .addChannelOption(opt => opt.setName('category').setDescription('Category channel where tokens are opened').addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption(opt => opt.setName('logs_channel').setDescription('Channel where token transcripts are logged').addChannelTypes(ChannelType.GuildText)),

    new SlashCommandBuilder()
        .setName('token-close')
        .setDescription('Close and archive the current token')
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for closing token')),

    new SlashCommandBuilder()
        .setName('token-claim')
        .setDescription('Claim this token as your assigned issue'),

    new SlashCommandBuilder()
        .setName('token-priority')
        .setDescription('Set the priority level of this token')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption(opt => opt.setName('level').setDescription('Priority level').setRequired(true)
            .addChoices(
                { name: '🟢 Low', value: 'Low' },
                { name: '🟡 Medium', value: 'Medium' },
                { name: '🟠 High', value: 'High' },
                { name: '🔴 Urgent', value: 'Urgent' }
            ))
].map(cmd => cmd.toJSON());

// 4. Client Ready Event
client.once('clientReady', async () => {
    console.log(`LoggedIn as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Slash commands registered successfully!');
    } catch (err) {
        console.error('Error registering commands:', err);
    }
});

// Helper: Generate Text Transcript File
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

    messages.reverse(); // Chronological order

    let transcriptText = `==================================================\n`;
    transcriptText += `TRANSCRIPT FOR TOKEN: #${channel.name}\n`;
    transcriptText += `GENERATED ON: ${new Date().toUTCString()}\n`;
    transcriptText += `==================================================\n\n`;

    messages.forEach(msg => {
        const timestamp = msg.createdAt.toISOString().replace('T', ' ').substring(0, 19);
        const author = `${msg.author.tag} (${msg.author.id})`;
        const content = msg.content || (msg.embeds.length > 0 ? '[Embed Message]' : '[No Text Content]');
        
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

// Helper: Close Token and Send Logs
async function closeTokenSession(channel, closedBy, reason = 'No reason provided') {
    const guild = channel.guild;
    const config = tokenGuildConfigs.get(guild.id) || {};

    const attachment = await generateTranscript(channel);

    // Extract target user from channel permissions or first embed
    let tokenOpener = null;
    try {
        const firstMsg = (await channel.messages.fetch({ limit: 10, oldest: true })).first();
        if (firstMsg && firstMsg.mentions.users.size > 0) {
            tokenOpener = firstMsg.mentions.users.first();
        }
    } catch (e) {
        console.error('Error finding token opener:', e);
    }

    const logEmbed = new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle('🔒 Token Closed & Archived')
        .addFields(
            { name: '📁 Token Channel', value: `\`${channel.name}\``, inline: true },
            { name: '👤 Closed By', value: `${closedBy}`, inline: true },
            { name: '👤 Opened By', value: tokenOpener ? `${tokenOpener}` : 'Unknown', inline: true },
            { name: '📝 Reason', value: `\`\`\`${reason}\`\`\``, inline: false }
        )
        .setTimestamp();

    // 1. Send Transcript DM to User
    if (tokenOpener) {
        try {
            await tokenOpener.send({
                content: `📄 Here is the transcript log for your closed token in **${guild.name}**:`,
                embeds: [logEmbed],
                files: [attachment]
            });
        } catch (e) {
            console.log(`Failed to DM transcript to ${tokenOpener.tag}:`, e.message);
        }
    }

    // 2. Send Transcript to Dedicated Server Log Channel
    if (config.logsChannelId) {
        const logsChannel = guild.channels.cache.get(config.logsChannelId);
        if (logsChannel) {
            try {
                await logsChannel.send({
                    embeds: [logEmbed],
                    files: [attachment]
                });
            } catch (e) {
                console.error('Failed to send transcript to logs channel:', e);
            }
        }
    }

    // Delete Channel
    setTimeout(() => {
        channel.delete().catch(() => {});
    }, 3000);
}

// 5. Auto-Responder
client.on('messageCreate', (msg) => {
    if (msg.author.bot) return;
    const trigger = msg.content.toLowerCase();
    if (autoResponders.has(trigger)) {
        msg.reply(autoResponders.get(trigger));
    }
});

// Helper for Token Creation
async function createTokenChannel(interaction, categoryValue, reason) {
    const guild = interaction.guild;
    const user = interaction.user;

    const config = tokenGuildConfigs.get(guild.id) || {};
    const supportRoleId = config.supportRoleId;
    const categoryId = config.categoryId;

    let supportRole = supportRoleId ? guild.roles.cache.get(supportRoleId) : null;
    if (!supportRole) {
        supportRole = guild.roles.cache.find(r => r.name.toLowerCase().includes('support') || r.name.toLowerCase().includes('staff')) || guild.roles.everyone;
    }

    let category = categoryId ? guild.channels.cache.get(categoryId) : null;
    if (!category) {
        category = guild.channels.cache.find(c => c.name.toLowerCase() === 'tokens' && c.type === ChannelType.GuildCategory);
        if (!category) {
            try {
                category = await guild.channels.create({
                    name: 'Tokens',
                    type: ChannelType.GuildCategory
                });
            } catch (e) {
                category = null;
            }
        }
    }

    const tokenId = Math.floor(1000 + Math.random() * 9000);
    const channelName = `token-${tokenId}`;

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

        const rotiEmbed = new EmbedBuilder()
            .setColor('#2F3136')
            .setTitle(`🎟️ Token System | ${categoryValue.toUpperCase()}`)
            .setDescription(`Welcome ${user}! Support will be with you shortly.\n\nPlease describe your request in detail if you haven't already.`)
            .addFields(
                { name: '👤 Opened By', value: `${user}`, inline: true },
                { name: '📌 Category', value: `\`${categoryValue}\``, inline: true },
                { name: '📝 Reason / Subject', value: `\`\`\`${reason}\`\`\``, inline: false },
                { name: '⚙️ Token Dashboard', value: 'Use the buttons below to manage this token session.' }
            )
            .setFooter({ text: `Token ID: #${tokenId} • R.O.T.I Module`, iconURL: guild.iconURL() || undefined })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('token_close_btn').setLabel('Close Token').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('token_claim_btn').setLabel('Claim Token').setStyle(ButtonStyle.Success).setEmoji('🙋‍♂️'),
            new ButtonBuilder().setCustomId('token_priority_btn').setLabel('Priority').setStyle(ButtonStyle.Secondary).setEmoji('⚡')
        );

        await channel.send({ content: `${user} | ${supportRole}`, embeds: [rotiEmbed], components: [row] });
        await interaction.reply({ content: `✅ Token created! Head over to ${channel}`, ephemeral: true });
    } catch (err) {
        console.error('Error creating token channel:', err);
        await interaction.reply({ content: '❌ Failed to create token channel. Please check bot permissions.', ephemeral: true });
    }
}

// 6. Interaction Handler
client.on('interactionCreate', async (interaction) => {

    // --- Command: /announce ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
        const hasPerms = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
        if (!hasPerms) {
            return interaction.reply({ content: '❌ You need Administrator or Manage Messages permissions to use this command!', ephemeral: true });
        }

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

        const modal = new ModalBuilder()
            .setCustomId('announceModal')
            .setTitle('Announcement Description & Values');

        const descInput = new TextInputBuilder()
            .setCustomId('descInput')
            .setLabel("1. Description (Main Message)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Paste main announcement text here...")
            .setRequired(true);

        const field1Input = new TextInputBuilder().setCustomId('field1Input').setLabel("2. Field 1 Value (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false);
        const field2Input = new TextInputBuilder().setCustomId('field2Input').setLabel("3. Field 2 Value (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false);
        const field3Input = new TextInputBuilder().setCustomId('field3Input').setLabel("4. Field 3 Value (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false);
        const imageInput = new TextInputBuilder().setCustomId('imageInput').setLabel("5. Image / Banner URL (Optional)").setStyle(TextInputStyle.Short).setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(descInput),
            new ActionRowBuilder().addComponents(field1Input),
            new ActionRowBuilder().addComponents(field2Input),
            new ActionRowBuilder().addComponents(field3Input),
            new ActionRowBuilder().addComponents(imageInput)
        );

        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'announceModal') {
        await interaction.deferReply({ ephemeral: true });

        const options = tempAnnounceData.get(interaction.user.id);
        if (!options) return interaction.editReply('Session expired! Please run /announce again.');

        const targetChannel = interaction.guild.channels.cache.get(options.channelId);
        const description = interaction.fields.getTextInputValue('descInput');
        const field1Val = interaction.fields.getTextInputValue('field1Input');
        const field2Val = interaction.fields.getTextInputValue('field2Input');
        const field3Val = interaction.fields.getTextInputValue('field3Input');
        const imageUrl = interaction.fields.getTextInputValue('imageInput');

        let color = options.color;
        if (!color.startsWith('#')) color = `#${color}`;

        const embed = new EmbedBuilder().setDescription(description);
        try { embed.setColor(color); } catch (e) { embed.setColor('#FFD700'); }

        if (options.title) embed.setTitle(options.title);
        if (options.authorName) {
            embed.setAuthor({
                name: options.authorName,
                iconURL: isValidUrl(options.authorIcon) ? options.authorIcon : undefined
            });
        }
        if (isValidUrl(options.thumbnail)) embed.setThumbnail(options.thumbnail);
        if (field1Val) embed.addFields({ name: options.field1Title || '\u200B', value: field1Val, inline: false });
        if (field2Val) embed.addFields({ name: options.field2Title || '\u200B', value: field2Val, inline: false });
        if (field3Val) embed.addFields({ name: options.field3Title || '\u200B', value: field3Val, inline: false });
        if (isValidUrl(imageUrl)) embed.setImage(imageUrl);

        if (options.footerText) {
            embed.setFooter({
                text: options.footerText,
                iconURL: isValidUrl(options.footerIcon) ? options.footerIcon : undefined
            });
        }

        if (targetChannel) {
            await targetChannel.send({ embeds: [embed] });
            if (options.sendDM) {
                try {
                    const members = await interaction.guild.members.fetch();
                    for (const [, m] of members) {
                        if (!m.user.bot) {
                            try { await m.send({ embeds: [embed] }); } catch (e) {}
                        }
                    }
                } catch (dmErr) {
                    console.error('Error fetching members for DM:', dmErr);
                }
            }
            await interaction.editReply('Announcement posted successfully!');
        } else {
            await interaction.editReply('Channel not found!');
        }
        tempAnnounceData.delete(interaction.user.id);
    }

    // --- Command: /autorespond ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'autorespond') {
        const hasPerms = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!hasPerms) {
            return interaction.reply({ content: '❌ You need Manage Messages or Administrator permissions to set auto-responders!', ephemeral: true });
        }
        const trigger = interaction.options.getString('trigger').toLowerCase();
        const reply = interaction.options.getString('reply');
        autoResponders.set(trigger, reply);
        await interaction.reply({ content: `Auto-responder set for \`${trigger}\`!`, ephemeral: true });
    }

    // --- TOKEN SYSTEM ---

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
            .setTitle('📩 Support Token Portal')
            .setDescription('Need assistance, have an inquiry, or want to submit a request?\n\nSelect the appropriate **Token Category** from the dropdown menu below to open a token with our team.')
            .addFields(
                { name: '⚙️ General Support', value: 'Questions regarding the server, account, or rules.', inline: true },
                { name: '🐛 Bug / Technical Report', value: 'Report bugs or tech glitches.', inline: true },
                { name: '💼 Billing / Donator Request', value: 'Assistance with store items or perks.', inline: true }
            )
            .setFooter({ text: 'R.O.T.I Token Module • Select below to proceed', iconURL: interaction.guild.iconURL() || undefined });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('token_category_select')
            .setPlaceholder('Click here to select a Token category...')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('General Support').setValue('general').setDescription('General questions or help').setEmoji('💬'),
                new StringSelectMenuOptionBuilder().setLabel('Bug Report').setValue('bug').setDescription('Report broken features or bugs').setEmoji('🐛'),
                new StringSelectMenuOptionBuilder().setLabel('Billing / Store').setValue('billing').setDescription('Store transactions or billing inquiry').setEmoji('💳'),
                new StringSelectMenuOptionBuilder().setLabel('Other Inquiry').setValue('other').setDescription('Anything else not listed above').setEmoji('❓')
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        await targetChannel.send({ embeds: [panelEmbed], components: [row] });
        await interaction.reply({ content: `✅ Token panel posted to ${targetChannel}! Logs target: ${logsChannel ? logsChannel : 'None set'}.`, ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'token_category_select') {
        const selectedCategory = interaction.values[0];

        const modal = new ModalBuilder()
            .setCustomId(`token_create_modal_${selectedCategory}`)
            .setTitle('Token Opening Form');

        const reasonInput = new TextInputBuilder()
            .setCustomId('token_reason')
            .setLabel('Describe your request or issue')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Enter brief details here...')
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('token_create_modal_')) {
        const categoryValue = interaction.customId.replace('token_create_modal_', '');
        const reason = interaction.fields.getTextInputValue('token_reason');
        await createTokenChannel(interaction, categoryValue, reason);
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'token_close_btn') {
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription('🔒 **Closing token and generating transcript...** Channel deleting in 3 seconds.')] });
            await closeTokenSession(interaction.channel, interaction.user);
        }

        if (interaction.customId === 'token_claim_btn') {
            const claimEmbed = new EmbedBuilder()
                .setColor('#57F287')
                .setDescription(`🙋‍♂️ Token claimed by ${interaction.user}! They will be assisting you.`);
            await interaction.reply({ embeds: [claimEmbed] });
        }

        if (interaction.customId === 'token_priority_btn') {
            const priorityMenu = new StringSelectMenuBuilder()
                .setCustomId('token_priority_select')
                .setPlaceholder('Set Priority Level...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Low Priority').setValue('Low').setEmoji('🟢'),
                    new StringSelectMenuOptionBuilder().setLabel('Medium Priority').setValue('Medium').setEmoji('🟡'),
                    new StringSelectMenuOptionBuilder().setLabel('High Priority').setValue('High').setEmoji('🟠'),
                    new StringSelectMenuOptionBuilder().setLabel('Urgent Priority').setValue('Urgent').setEmoji('🔴')
                );
            const row = new ActionRowBuilder().addComponents(priorityMenu);
            await interaction.reply({ content: 'Select token priority level:', components: [row], ephemeral: true });
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'token_priority_select') {
        const level = interaction.values[0];
        await interaction.update({ content: `✅ Priority set to **${level}**.`, components: [] });
        await interaction.channel.send({ embeds: [new EmbedBuilder().setColor('#FEE75C').setDescription(`⚡ Token priority updated to **${level}** by ${interaction.user}.`)] });
    }

    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'token-close') {
            if (!interaction.channel.name.startsWith('token-')) {
                return interaction.reply({ content: '❌ You can only use this command inside an active token channel.', ephemeral: true });
            }
            const reason = interaction.options.getString('reason') || 'No reason provided';
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ED4245').setDescription(`🔒 Closing token: **${reason}**. Channel deleting in 3 seconds...`)] });
            await closeTokenSession(interaction.channel, interaction.user, reason);
        }

        if (interaction.commandName === 'token-claim') {
            if (!interaction.channel.name.startsWith('token-')) {
                return interaction.reply({ content: '❌ You can only use this command inside an active token channel.', ephemeral: true });
            }
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setDescription(`🙋‍♂️ Token claimed by ${interaction.user}!`)] });
        }

        if (interaction.commandName === 'token-priority') {
            if (!interaction.channel.name.startsWith('token-')) {
                return interaction.reply({ content: '❌ You can only use this command inside an active token channel.', ephemeral: true });
            }
            const level = interaction.options.getString('level');
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FEE75C').setDescription(`⚡ Priority set to **${level}** by ${interaction.user}.`)] });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
