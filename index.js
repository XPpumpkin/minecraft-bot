require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    PermissionFlagsBits 
} = require('discord.js');
const http = require('http');

// Global Unhandled Error Catchers (Prevents silent hanging)
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
});

// HTTP Keep-Alive Server for Render
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
}).listen(port, () => {
    console.log(`Keep-alive server listening on port ${port}`);
});

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// System Configurations
const config = {
    colors: {
        primary: '#5865F2',
        success: '#57F287',
        danger: '#ED4245',
        warning: '#FEE75C',
        dark: '#2B2D31'
    }
};

// Temporary Memory Stores
const tempAnnounceData = new Map();
const autoResponders = new Map();
const customButtonActions = new Map();

// Helper Functions
function isValidUrl(string) {
    if (!string) return false;
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// Bot Ready Event
client.once('ready', () => {
    console.log(`✅ Bot logged in successfully as ${client.user.tag}`);
});

// Auto Responder Message Listener
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const content = message.content.toLowerCase();
    if (autoResponders.has(content)) {
        await message.reply(autoResponders.get(content));
    }
});

// Interaction Create Listener
client.on('interactionCreate', async (interaction) => {

    // --- Command: /buttonbuilder Setup ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'buttonbuilder') {
        const modal = new ModalBuilder()
            .setCustomId('button_builder_modal')
            .setTitle('Button Creator Builder');

        const labelInput = new TextInputBuilder()
            .setCustomId('btn_label')
            .setLabel('Button Label / Text')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Click Me!')
            .setRequired(true);

        const styleInput = new TextInputBuilder()
            .setCustomId('btn_style')
            .setLabel('Style (Primary, Secondary, Success, Danger, Link)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Primary')
            .setRequired(true);

        const emojiInput = new TextInputBuilder()
            .setCustomId('btn_emoji')
            .setLabel('Button Emoji (Optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('')
            .setRequired(false);

        const valueInput = new TextInputBuilder()
            .setCustomId('btn_value')
            .setLabel('Response Message / Role ID / Link URL')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('e.g., role:1234567890 OR https://example.com OR Custom Reply')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(labelInput),
            new ActionRowBuilder().addComponents(styleInput),
            new ActionRowBuilder().addComponents(emojiInput),
            new ActionRowBuilder().addComponents(valueInput)
        );

        await interaction.showModal(modal);
    }

    // --- Command: /announce Setup ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'announce') {
        const targetChannel = interaction.options.getChannel('channel');
        const color = interaction.options.getString('color') || '#FFD700';
        const title = interaction.options.getString('title');
        const authorName = interaction.options.getString('author_name');
        const authorIcon = interaction.options.getString('author_icon');
        const thumbnail = interaction.options.getString('thumbnail'); 
        const field1Title = interaction.options.getString('field1_title');
        const field2Title = interaction.options.getString('field2_title');
        const field3Title = interaction.options.getString('field3_title');
        const footerText = interaction.options.getString('footer_text');
        const footerIcon = interaction.options.getString('footer_icon');
        const sendDM = interaction.options.getBoolean('send_dm') || false;

        tempAnnounceData.set(interaction.user.id, {
            channelId: targetChannel.id, color, title, authorName, authorIcon,
            thumbnail, field1Title, field2Title, field3Title, footerText, footerIcon, sendDM
        });

        const modal = new ModalBuilder()
            .setCustomId('announceModal')
            .setTitle('Announcement Builder');

        const descInput = new TextInputBuilder()
            .setCustomId('descInput')
            .setLabel("1. Embed Description (Main Content)")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const field1Input = new TextInputBuilder().setCustomId('field1Input').setLabel("2. Field 1 Value (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false);
        const field2Input = new TextInputBuilder().setCustomId('field2Input').setLabel("3. Field 2 Value (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false);
        const field3Input = new TextInputBuilder().setCustomId('field3Input').setLabel("4. Field 3 Value (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false);
        const contentInput = new TextInputBuilder().setCustomId('contentInput').setLabel("5. Message Content (Outside Embed)").setStyle(TextInputStyle.Paragraph).setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(descInput),
            new ActionRowBuilder().addComponents(field1Input),
            new ActionRowBuilder().addComponents(field2Input),
            new ActionRowBuilder().addComponents(field3Input),
            new ActionRowBuilder().addComponents(contentInput)
        );

        await interaction.showModal(modal);
    }

    // --- Command: /announce Modal Submission Handler ---
    if (interaction.isModalSubmit() && interaction.customId === 'announceModal') {
        await interaction.deferReply({ ephemeral: true });

        const options = tempAnnounceData.get(interaction.user.id);
        if (!options) return interaction.editReply('Session expired! Please run /announce again.');

        const targetChannel = interaction.guild.channels.cache.get(options.channelId);
        const description = interaction.fields.getTextInputValue('descInput');
        const field1Val = interaction.fields.getTextInputValue('field1Input');
        const field2Val = interaction.fields.getTextInputValue('field2Input');
        const field3Val = interaction.fields.getTextInputValue('field3Input');
        const outsideContent = interaction.fields.getTextInputValue('contentInput');

        let color = options.color;
        if (!color.startsWith('#')) color = `#${color}`;

        // Process {server} and {guild} placeholders for the channel Embed
        const guildName = interaction.guild.name;
        const processedDescription = description
            .replace(/{server}/g, guildName)
            .replace(/{guild}/g, guildName);

        const embed = new EmbedBuilder().setDescription(processedDescription);
        try { embed.setColor(color); } catch (e) { embed.setColor('#FFD700'); }

        if (options.title) {
            embed.setTitle(options.title.replace(/{server}/g, guildName).replace(/{guild}/g, guildName));
        }

        if (options.authorName) {
            embed.setAuthor({
                name: options.authorName.replace(/{server}/g, guildName).replace(/{guild}/g, guildName),
                iconURL: isValidUrl(options.authorIcon) ? options.authorIcon : undefined
            });
        }
        
        if (isValidUrl(options.thumbnail)) embed.setImage(options.thumbnail);

        if (field1Val) {
            embed.addFields({ 
                name: (options.field1Title || '\u200B').replace(/{server}/g, guildName).replace(/{guild}/g, guildName), 
                value: field1Val.replace(/{server}/g, guildName).replace(/{guild}/g, guildName), 
                inline: false 
            });
        }
        if (field2Val) {
            embed.addFields({ 
                name: (options.field2Title || '\u200B').replace(/{server}/g, guildName).replace(/{guild}/g, guildName), 
                value: field2Val.replace(/{server}/g, guildName).replace(/{guild}/g, guildName), 
                inline: false 
            });
        }
        if (field3Val) {
            embed.addFields({ 
                name: (options.field3Title || '\u200B').replace(/{server}/g, guildName).replace(/{guild}/g, guildName), 
                value: field3Val.replace(/{server}/g, guildName).replace(/{guild}/g, guildName), 
                inline: false 
            });
        }

        if (options.footerText) {
            embed.setFooter({
                text: options.footerText.replace(/{server}/g, guildName).replace(/{guild}/g, guildName),
                iconURL: isValidUrl(options.footerIcon) ? options.footerIcon : undefined
            });
        }

        // Clean user tags for main channel, but convert {server} / {guild}
        let serverContent = outsideContent
            ? outsideContent
                .replace(/{user}/g, '')
                .replace(/{displayname}/g, '')
                .replace(/{username}/g, '')
                .replace(/{server}/g, guildName)
                .replace(/{guild}/g, guildName)
                .trim()
            : null;

        const messagePayload = { embeds: [embed] };
        if (serverContent) {
            messagePayload.content = serverContent;
        }

        if (targetChannel) {
            // Send payload to target channel
            await targetChannel.send(messagePayload);

            // Send payload to Members via DM if requested
            if (options.sendDM) {
                try {
                    const members = await interaction.guild.members.fetch();
                    for (const [, member] of members) {
                        if (!member.user.bot) {
                            try {
                                const dmEmbed = EmbedBuilder.from(embed);

                                if (description) {
                                    dmEmbed.setDescription(
                                        description
                                            .replace(/{user}/g, `<@${member.id}>`)
                                            .replace(/{displayname}/g, member.displayName)
                                            .replace(/{username}/g, member.user.username)
                                            .replace(/{server}/g, guildName)
                                            .replace(/{guild}/g, guildName)
                                    );
                                }

                                if (options.title) {
                                    dmEmbed.setTitle(
                                        options.title
                                            .replace(/{displayname}/g, member.displayName)
                                            .replace(/{username}/g, member.user.username)
                                            .replace(/{server}/g, guildName)
                                            .replace(/{guild}/g, guildName)
                                    );
                                }

                                let dmContent = outsideContent
                                    ? outsideContent
                                        .replace(/{user}/g, `<@${member.id}>`)
                                        .replace(/{displayname}/g, member.displayName)
                                        .replace(/{username}/g, member.user.username)
                                        .replace(/{server}/g, guildName)
                                        .replace(/{guild}/g, guildName)
                                    : null;

                                const dmPayload = { embeds: [dmEmbed] };
                                if (dmContent) dmPayload.content = dmContent;

                                await member.send(dmPayload);
                            } catch (e) {
                                // Silent error handling for closed DMs
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

    // --- Command: /buttonbuilder Modal Submission Handler ---
    if (interaction.isModalSubmit() && interaction.customId === 'button_builder_modal') {
        const label = interaction.fields.getTextInputValue('btn_label');
        const styleInput = interaction.fields.getTextInputValue('btn_style').toUpperCase();
        const emoji = interaction.fields.getTextInputValue('btn_emoji');
        const value = interaction.fields.getTextInputValue('btn_value');

        let style = ButtonStyle.Primary;
        if (styleInput === 'SECONDARY' || styleInput === 'GRAY') style = ButtonStyle.Secondary;
        if (styleInput === 'SUCCESS' || styleInput === 'GREEN') style = ButtonStyle.Success;
        if (styleInput === 'DANGER' || styleInput === 'RED') style = ButtonStyle.Danger;
        if (styleInput === 'LINK' || styleInput === 'URL') style = ButtonStyle.Link;

        const button = new ButtonBuilder().setLabel(label).setStyle(style);
        if (emoji) {
            try { button.setEmoji(emoji); } catch (e) {}
        }

        if (style === ButtonStyle.Link) {
            if (!isValidUrl(value)) {
                return interaction.reply({ content: 'URL buttons require a valid web address starting with http:// or https://', ephemeral: true });
            }
            button.setURL(value);
        } else {
            const customId = `custom_btn_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            button.setCustomId(customId);
            customButtonActions.set(customId, { value: value, style: styleInput });
        }

        const embed = new EmbedBuilder()
            .setColor(config.colors.primary)
            .setTitle('Interactive Button Created')
            .setDescription(`Here is your standard message attached with your custom button:\n\n**Action Value:** \`${value || 'None'}\``)
            .setFooter({ text: 'Interactive Button System', iconURL: interaction.guild.iconURL() || undefined });

        await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
    }

    // --- Dynamic Custom Button Click Listener ---
    if (interaction.isButton() && interaction.customId.startsWith('custom_btn_')) {
        const actionData = customButtonActions.get(interaction.customId);
        if (!actionData || !actionData.value) {
            return interaction.reply({ content: 'Button action triggered!', ephemeral: true });
        }

        // Role Assign Logic
        if (actionData.value.startsWith('role:')) {
            const roleId = actionData.value.replace('role:', '').trim();
            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) {
                return interaction.reply({ content: 'Target role could not be found on this server.', ephemeral: true });
            }
            if (interaction.member.roles.cache.has(role.id)) {
                await interaction.member.roles.remove(role);
                return interaction.reply({ content: `➖ Removed role **${role.name}** from your profile.`, ephemeral: true });
            } else {
                await interaction.member.roles.add(role);
                return interaction.reply({ content: `➕ Granted role **${role.name}** to your profile!`, ephemeral: true });
            }
        }

        // Custom Ephemeral Text Reply
        await interaction.reply({ content: actionData.value, ephemeral: true });
    }

    // --- Command: /autorespond ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'autorespond') {
        const hasPerms = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
        if (!hasPerms) {
            return interaction.reply({ content: 'You need Manage Messages or Administrator permissions to set auto-responders!', ephemeral: true });
        }
        const trigger = interaction.options.getString('trigger').toLowerCase();
        const reply = interaction.options.getString('reply');
        autoResponders.set(trigger, reply);
        await interaction.reply({ content: `Auto-responder set for \`${trigger}\`!`, ephemeral: true });
    }
});

// Robust Login Handling with Error Catching & Debugging
const token = process.env.DISCORD_TOKEN;

console.log('🔄 Attempting login to Discord Gateway...');
if (!token) {
    console.error('❌ CRITICAL: process.env.DISCORD_TOKEN is EMPTY or UNDEFINED!');
} else {
    console.log(`🔑 Token detected! (Length: ${token.length} chars)`);
    client.login(token)
        .then(() => console.log('🎉 Login promise resolved!'))
        .catch((err) => console.error('❌ DISCORD LOGIN REJECTED:', err));
}
