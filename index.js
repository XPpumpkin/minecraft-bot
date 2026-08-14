const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const express = require('express');
require('dotenv').config();

// 1. Keep-Alive Web Server
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Keep-alive server running.'));

// 2. Initialize Discord Client (Added GuildMembers Intent for DM functionality)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers // Required to fetch members for DMs
    ],
    partials: [Partials.Channel, Partials.Message]
});

const tempAnnounceData = new Map();
const autoResponders = new Map();

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
        .addStringOption(opt => opt.setName('reply').setDescription('Bot response').setRequired(true))
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

// 5. Auto-Responder
client.on('messageCreate', (msg) => {
    if (msg.author.bot) return;
    const trigger = msg.content.toLowerCase();
    if (autoResponders.has(trigger)) {
        msg.reply(autoResponders.get(trigger));
    }
});

// 6. Interaction Handler
client.on('interactionCreate', async (interaction) => {
    
    // Command: /announce
    if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
        
        // Admin / Moderator Permission Check
        const hasPerms = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
        if (!hasPerms) {
            return interaction.reply({ content: '❌ You need Administrator or Manage Messages permissions to use this command!', ephemeral: true });
        }

        // Save options typed in the command bar
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

        // Exactly 5 Modal Text Areas
        const modal = new ModalBuilder()
            .setCustomId('announceModal')
            .setTitle('Announcement Description & Values');

        const descInput = new TextInputBuilder()
            .setCustomId('descInput')
            .setLabel("1. Description (Main Message)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Paste main announcement text here (full lining/spacing)...")
            .setRequired(true);

        const field1Input = new TextInputBuilder()
            .setCustomId('field1Input')
            .setLabel("2. Field 1 Value (Optional)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Text / Content for Field 1...")
            .setRequired(false);

        const field2Input = new TextInputBuilder()
            .setCustomId('field2Input')
            .setLabel("3. Field 2 Value (Optional)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Text / Content for Field 2...")
            .setRequired(false);

        const field3Input = new TextInputBuilder()
            .setCustomId('field3Input')
            .setLabel("4. Field 3 Value (Optional)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Text / Content for Field 3...")
            .setRequired(false);

        const imageInput = new TextInputBuilder()
            .setCustomId('imageInput')
            .setLabel("5. Image / Banner URL (Optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Direct Banner Image URL (http/https)...")
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(descInput),
            new ActionRowBuilder().addComponents(field1Input),
            new ActionRowBuilder().addComponents(field2Input),
            new ActionRowBuilder().addComponents(field3Input),
            new ActionRowBuilder().addComponents(imageInput)
        );

        await interaction.showModal(modal);
    }

    // Modal Submission Logic
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

        // Created Embed WITHOUT .setTimestamp() so no date/time shows in the footer
        const embed = new EmbedBuilder()
            .setDescription(description);

        try { embed.setColor(color); } catch (e) { embed.setColor('#FFD700'); }

        // Embed Title
        if (options.title) embed.setTitle(options.title);

        // Author Name & Author Icon (Only sets if author_name is explicitly provided)
        if (options.authorName) {
            embed.setAuthor({
                name: options.authorName,
                iconURL: isValidUrl(options.authorIcon) ? options.authorIcon : undefined
            });
        }

        // Thumbnail Image
        if (isValidUrl(options.thumbnail)) embed.setThumbnail(options.thumbnail);

        // Field 1 Lineup
        if (field1Val) {
            const f1Title = options.field1Title || '\u200B';
            embed.addFields({ name: f1Title, value: field1Val, inline: false });
        }

        // Field 2 Lineup
        if (field2Val) {
            const f2Title = options.field2Title || '\u200B';
            embed.addFields({ name: f2Title, value: field2Val, inline: false });
        }

        // Field 3 Lineup
        if (field3Val) {
            const f3Title = options.field3Title || '\u200B';
            embed.addFields({ name: f3Title, value: field3Val, inline: false });
        }

        // Main Banner Image URL
        if (isValidUrl(imageUrl)) embed.setImage(imageUrl);

        // Footer Text & Footer Icon (Clean text without date)
        if (options.footerText) {
            embed.setFooter({
                text: options.footerText,
                iconURL: isValidUrl(options.footerIcon) ? options.footerIcon : undefined
            });
        }

        // Send Embed Message
        if (targetChannel) {
            await targetChannel.send({ embeds: [embed] });

            if (options.sendDM) {
                try {
                    const members = await interaction.guild.members.fetch();
                    for (const [, m] of members) {
                        if (!m.user.bot) {
                            try { 
                                await m.send({ embeds: [embed] }); 
                            } catch (e) {
                                // Handles users who have DMs closed or blocked the bot
                            }
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

    // Command: /autorespond
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
});

client.login(process.env.DISCORD_TOKEN);