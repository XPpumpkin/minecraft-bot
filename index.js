const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, 
    UserSelectMenuBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    PermissionFlagsBits, 
    ChannelType, 
    AttachmentBuilder 
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const http = require('http');

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

// Database Setup
const db = new Database(path.join(__dirname, 'tickets.db'));

// Create Database Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS config (
        guild_id TEXT PRIMARY KEY,
        support_role_id TEXT,
        staff_role_id TEXT,
        category_id TEXT,
        logs_channel_id TEXT,
        transcript_channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        formatted_id TEXT,
        guild_id TEXT,
        channel_id TEXT,
        user_id TEXT,
        type TEXT,
        reason TEXT,
        status TEXT DEFAULT 'open',
        claimed_by TEXT,
        priority TEXT DEFAULT 'normal',
        created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS blacklists (
        user_id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS staff_stats (
        staff_id TEXT PRIMARY KEY,
        resolved_count INTEGER DEFAULT 0
    );
`);

// Database Operations Helper
const dbOps = {
    getConfig: (guildId) => db.prepare('SELECT * FROM config WHERE guild_id = ?').get(guildId),
    setConfig: (guildId, supportRole, staffRole, category, logs, transcript) => {
        db.prepare(`
            INSERT INTO config (guild_id, support_role_id, staff_role_id, category_id, logs_channel_id, transcript_channel_id)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
                support_role_id = excluded.support_role_id,
                staff_role_id = excluded.staff_role_id,
                category_id = excluded.category_id,
                logs_channel_id = excluded.logs_channel_id,
                transcript_channel_id = excluded.transcript_channel_id
        `).run(guildId, supportRole, staffRole, category, logs, transcript);
    },
    createToken: (guildId, userId, type, reason) => {
        const count = db.prepare('SELECT COUNT(*) as total FROM tickets WHERE guild_id = ?').get(guildId).total + 1;
        const formattedId = String(count).padStart(4, '0');
        const now = Date.now();

        const info = db.prepare(`
            INSERT INTO tickets (formatted_id, guild_id, user_id, type, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(formattedId, guildId, userId, type, reason, now);

        return { id: info.lastInsertRowid, formatted_id: formattedId };
    },
    updateTokenChannel: (id, channelId) => {
        db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channelId, id);
    },
    getTokenByChannel: (channelId) => db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId),
    updateTokenStatus: (channelId, status) => {
        db.prepare('UPDATE tickets SET status = ? WHERE channel_id = ?').run(status, channelId);
    },
    claimToken: (channelId, staffId) => {
        db.prepare('UPDATE tickets SET claimed_by = ? WHERE channel_id = ?').run(staffId, channelId);
    },
    unclaimToken: (channelId) => {
        db.prepare('UPDATE tickets SET claimed_by = NULL WHERE channel_id = ?').run(channelId);
    },
    setPriority: (channelId, level) => {
        db.prepare('UPDATE tickets SET priority = ? WHERE channel_id = ?').run(level, channelId);
    },
    isBlacklisted: (userId) => !!db.prepare('SELECT user_id FROM blacklists WHERE user_id = ?').get(userId),
    toggleBlacklist: (userId) => {
        if (dbOps.isBlacklisted(userId)) {
            db.prepare('DELETE FROM blacklists WHERE user_id = ?').run(userId);
            return false;
        } else {
            db.prepare('INSERT INTO blacklists (user_id) VALUES (?)').run(userId);
            return true;
        }
    },
    incrementStaffStat: (staffId) => {
        db.prepare(`
            INSERT INTO staff_stats (staff_id, resolved_count) VALUES (?, 1)
            ON CONFLICT(staff_id) DO UPDATE SET resolved_count = resolved_count + 1
        `).run(staffId);
    },
    getStats: () => db.prepare('SELECT * FROM staff_stats ORDER BY resolved_count DESC LIMIT 10').all(),
    getUserTokens: (userId) => db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC').all()
};

// System Configurations
const config = {
    colors: {
        primary: '#5865F2',
        success: '#57F287',
        danger: '#ED4245',
        warning: '#FEE75C',
        dark: '#2B2D31'
    },
    categories: [
        { label: 'General Support', value: 'general', emoji: '❓', description: 'General server inquiries & assistance' },
        { label: 'Store & Billing', value: 'billing', emoji: '💳', description: 'Store transactions & payment issues' },
        { label: 'Player Report', value: 'report', emoji: '🚨', description: 'Report a rule breaker or player' },
        { label: 'Bug Report', value: 'bug', emoji: '🐛', description: 'Report bugs or technical glitches' }
    ]
};

// Temporary Memory Stores
const tempAnnounceData = new Map();
const autoResponders = new Map();
const customButtonActions = new Map();

// Helper Functions
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

async function generateHtmlTranscript(channel, tokenRecord) {
    const messages = await channel.messages.fetch({ limit: 100 });
    const sortedMessages = Array.from(messages.values()).reverse();

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Transcript - #${tokenRecord ? tokenRecord.formatted_id : channel.name}</title>
        <style>
            body { background-color: #1e1f22; color: #dcddde; font-family: sans-serif; padding: 20px; }
            .header { border-bottom: 2px solid #35363c; padding-bottom: 10px; margin-bottom: 20px; }
            .msg { margin-bottom: 15px; display: flex; flex-direction: column; }
            .author { font-weight: bold; color: #5865F2; margin-bottom: 3px; }
            .time { font-size: 0.8em; color: #949ba4; margin-left: 8px; }
            .content { background-color: #2b2d31; padding: 10px; border-radius: 5px; width: fit-content; max-width: 80%; }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Transcript for ${channel.name}</h2>
            <p>Generated at: ${new Date().toLocaleString()}</p>
        </div>
    `;

    sortedMessages.forEach(m => {
        html += `
        <div class="msg">
            <div>
                <span class="author">${m.author.tag}</span>
                <span class="time">${m.createdAt.toLocaleString()}</span>
            </div>
            <div class="content">${m.content || '<i>[No text content / Embed / File]</i>'}</div>
        </div>
        `;
    });

    html += `</body></html>`;

    const filePath = path.join(__dirname, `transcript-${channel.id}.html`);
    fs.writeFileSync(filePath, html);

    const attachment = new AttachmentBuilder(filePath, { name: `transcript-${channel.name}.html` });
    setTimeout(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }, 10000);

    return attachment;
}

async function logTokenEvent(guild, embed) {
    const guildConfig = dbOps.getConfig(guild.id);
    if (!guildConfig || !guildConfig.logs_channel_id) return;
    const logChannel = guild.channels.cache.get(guildConfig.logs_channel_id);
    if (logChannel) {
        await logChannel.send({ embeds: [embed] });
    }
}

async function purgeTokenSession(channel, executor, reason = 'Token Session Purged') {
    const tokenRecord = dbOps.getTokenByChannel(channel.id);
    const guild = channel.guild;
    const guildConfig = dbOps.getConfig(guild.id);

    const attachment = await generateHtmlTranscript(channel, tokenRecord);

    if (guildConfig && guildConfig.transcript_channel_id) {
        const transcriptChannel = guild.channels.cache.get(guildConfig.transcript_channel_id);
        if (transcriptChannel) {
            const embed = new EmbedBuilder()
                .setColor(config.colors.primary)
                .setTitle(`📄 Transcript Archived • #${tokenRecord ? tokenRecord.formatted_id : 'Session'}`)
                .addFields(
                    { name: '📁 Channel', value: channel.name, inline: true },
                    { name: '👤 Creator', value: tokenRecord ? `<@${tokenRecord.user_id}>` : 'Unknown', inline: true },
                    { name: '🛡️ Closed By', value: `${executor}`, inline: true },
                    { name: '📝 Reason', value: reason }
                )
                .setTimestamp();

            await transcriptChannel.send({ embeds: [embed], files: [attachment] });
        }
    }

    if (tokenRecord && tokenRecord.claimed_by) {
        dbOps.incrementStaffStat(tokenRecord.claimed_by);
    }

    dbOps.updateTokenStatus(channel.id, 'closed');

    setTimeout(async () => {
        try {
            await channel.delete();
        } catch (err) {
            console.error('Failed to delete channel:', err);
        }
    }, 5000);
}

// R.O.T.I Style Ticket Opening Function
async function createTokenChannel(interaction, categoryValue, reason) {
    const { guild, user } = interaction;

    if (dbOps.isBlacklisted(user.id)) {
        return interaction.reply({ content: '❌ You are blacklisted from opening tokens/tickets.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const guildConfig = dbOps.getConfig(guild.id);
    const categoryConfig = config.categories.find(c => c.value === categoryValue);
    const tokenRecord = dbOps.createToken(guild.id, user.id, categoryValue, reason);

    const channelName = `ticket-${tokenRecord.formatted_id}`;
    const parentCategory = guildConfig?.category_id ? guild.channels.cache.get(guildConfig.category_id) : null;

    const permissionOverwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
    ];

    if (guildConfig?.support_role_id) {
        permissionOverwrites.push({ 
            id: guildConfig.support_role_id, 
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] 
        });
    }

    const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: parentCategory ? parentCategory.id : undefined,
        permissionOverwrites: permissionOverwrites
    });

    dbOps.updateTokenChannel(tokenRecord.id, channel.id);

    // R.O.T.I Ticket Control Embed Creation
    const rotiTicketEmbed = new EmbedBuilder()
        .setColor(config.colors.primary)
        .setTitle(`🎟️ R.O.T.I Support Ticket • #${tokenRecord.formatted_id}`)
        .setDescription(`Welcome ${user}! A member of our support team will be with you shortly.\n\n**Category:** ${categoryConfig?.emoji || '📁'} ${categoryConfig?.label || categoryValue}\n**Issue / Reason:** \`\`\`${reason}\`\`\``)
        .addFields(
            { name: '👤 Opened By', value: `${user}`, inline: true },
            { name: '🆔 Ticket ID', value: `#${tokenRecord.formatted_id}`, inline: true },
            { name: '⚡ Status', value: '`OPEN`', inline: true }
        )
        .setFooter({ text: 'R.O.T.I Ticket System • Use the controls below to manage', iconURL: guild.iconURL() || undefined })
        .setTimestamp();

    const controlRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('token_claim_btn').setLabel('Claim Ticket').setStyle(ButtonStyle.Success).setEmoji('🙋‍♂️'),
        new ButtonBuilder().setCustomId('token_lock_btn').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId('token_close_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('✖️')
    );

    const controlRow2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('token_add_user_btn').setLabel('Add User').setStyle(ButtonStyle.Primary).setEmoji('➕'),
        new ButtonBuilder().setCustomId('token_remove_user_btn').setLabel('Remove User').setStyle(ButtonStyle.Secondary).setEmoji('➖'),
        new ButtonBuilder().setCustomId('token_transcript_btn').setLabel('Transcript').setStyle(ButtonStyle.Primary).setEmoji('📄')
    );

    const supportPing = guildConfig?.support_role_id ? `<@&${guildConfig.support_role_id}>` : '';
    await channel.send({ 
        content: `Welcome ${user}! ${supportPing}`, 
        embeds: [rotiTicketEmbed], 
        components: [controlRow1, controlRow2] 
    });

    const logEmbed = new EmbedBuilder()
        .setColor(config.colors.primary)
        .setTitle('🎟️ Ticket Created')
        .addFields(
            { name: '🆔 ID', value: `#${tokenRecord.formatted_id}`, inline: true },
            { name: '📁 Category', value: categoryConfig?.label || categoryValue, inline: true },
            { name: '👤 Creator', value: `${user}`, inline: true },
            { name: '📝 Reason', value: reason }
        )
        .setTimestamp();

    await logTokenEvent(guild, logEmbed);

    await interaction.editReply({ content: `✅ Ticket created! Head over to ${channel}` });
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
            .setPlaceholder('⭐')
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
                return interaction.reply({ content: '❌ URL buttons require a valid web address starting with http:// or https://', ephemeral: true });
            }
            button.setURL(value);
        } else {
            const customId = `custom_btn_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            button.setCustomId(customId);
            customButtonActions.set(customId, { value: value, style: styleInput });
        }

        const embed = new EmbedBuilder()
            .setColor(config.colors.primary)
            .setTitle('🔘 Interactive Button Created')
            .setDescription(`Here is your standard message attached with your custom button:\n\n**Action Value:** \`${value || 'None'}\``)
            .setFooter({ text: 'R.O.T.I Interactive Button System', iconURL: interaction.guild.iconURL() || undefined });

        await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
    }

    // --- Dynamic Custom Button Click Listener ---
    if (interaction.isButton() && interaction.customId.startsWith('custom_btn_')) {
        const actionData = customButtonActions.get(interaction.customId);
        if (!actionData || !actionData.value) {
            return interaction.reply({ content: '🔘 Button action triggered!', ephemeral: true });
        }

        // Role Assign Logic
        if (actionData.value.startsWith('role:')) {
            const roleId = actionData.value.replace('role:', '').trim();
            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) {
                return interaction.reply({ content: '❌ Target role could not be found on this server.', ephemeral: true });
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
            return interaction.reply({ content: '❌ You need Manage Messages or Administrator permissions to set auto-responders!', ephemeral: true });
        }
        const trigger = interaction.options.getString('trigger').toLowerCase();
        const reply = interaction.options.getString('reply');
        autoResponders.set(trigger, reply);
        await interaction.reply({ content: `Auto-responder set for \`${trigger}\`!`, ephemeral: true });
    }

    // ==========================================
    // TOKEN / TICKET SYSTEM INTERACTIONS
    // ==========================================

    // Command: /tokensetup
    if (interaction.isChatInputCommand() && interaction.commandName === 'tokensetup') {
        const targetChannel = interaction.options.getChannel('channel');
        const supportRole = interaction.options.getRole('support_role');
        const staffRole = interaction.options.getRole('staff_role');
        const categoryChannel = interaction.options.getChannel('category');
        const logsChannel = interaction.options.getChannel('logs_channel');
        const transcriptChannel = interaction.options.getChannel('transcript_channel');

        dbOps.setConfig(
            interaction.guild.id,
            supportRole.id,
            staffRole ? staffRole.id : null,
            categoryChannel ? categoryChannel.id : null,
            logsChannel ? logsChannel.id : null,
            transcriptChannel ? transcriptChannel.id : null
        );

        const panelEmbed = new EmbedBuilder()
            .setColor(config.colors.dark)
            .setTitle('📩 Support Token Portal')
            .setDescription('Need assistance, have a store inquiry, or want to submit a report?\n\nSelect the appropriate token category from the menu below to start a private session with our team.')
            .setFooter({ text: 'R.O.T.I Support System • Select below to proceed', iconURL: interaction.guild.iconURL() || undefined });

        config.categories.forEach(cat => {
            panelEmbed.addFields({ name: `${cat.emoji} ${cat.label}`, value: cat.description, inline: true });
        });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('token_category_select')
            .setPlaceholder('Click here to select a token category...')
            .addOptions(
                config.categories.map(cat => 
                    new StringSelectMenuOptionBuilder()
                        .setLabel(cat.label)
                        .setValue(cat.value)
                        .setDescription(cat.description)
                        .setEmoji(cat.emoji)
                )
            );

        await targetChannel.send({ embeds: [panelEmbed], components: [new ActionRowBuilder().addComponents(selectMenu)] });
        await interaction.reply({ content: `✅ Token portal successfully configured and sent to ${targetChannel}!`, ephemeral: true });
    }

    // Command: /tokenpanel
    if (interaction.isChatInputCommand() && interaction.commandName === 'tokenpanel') {
        const panelEmbed = new EmbedBuilder()
            .setColor(config.colors.dark)
            .setTitle('📩 Support Token Portal')
            .setDescription('Select a category from the dropdown menu below to open a support token.')
            .setFooter({ text: 'R.O.T.I Support System', iconURL: interaction.guild.iconURL() || undefined });

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('token_category_select')
            .setPlaceholder('Click here to select a token category...')
            .addOptions(
                config.categories.map(cat => 
                    new StringSelectMenuOptionBuilder()
                        .setLabel(cat.label)
                        .setValue(cat.value)
                        .setDescription(cat.description)
                        .setEmoji(cat.emoji)
                )
            );

        await interaction.channel.send({ embeds: [panelEmbed], components: [new ActionRowBuilder().addComponents(selectMenu)] });
        await interaction.reply({ content: '✅ Token panel posted!', ephemeral: true });
    }

    // Category Menu Handler
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

    // Creation Modal Handler
    if (interaction.isModalSubmit() && interaction.customId.startsWith('token_create_modal_')) {
        const categoryValue = interaction.customId.replace('token_create_modal_', '');
        const reason = interaction.fields.getTextInputValue('token_reason');
        await createTokenChannel(interaction, categoryValue, reason);
    }

    // Button Router for Token / Ticket Actions
    if (interaction.isButton()) {
        const { customId, channel, guild, user, member } = interaction;
        const tokenRecord = dbOps.getTokenByChannel(channel.id);

        if (customId === 'token_close_btn') {
            const modal = new ModalBuilder()
                .setCustomId('token_close_modal')
                .setTitle('Close Token');

            const reasonInput = new TextInputBuilder()
                .setCustomId('close_reason')
                .setLabel('Reason for closing token')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g. Issue resolved')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
            await interaction.showModal(modal);
        }

        if (customId === 'token_claim_btn') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ Only support staff can claim tokens.', ephemeral: true });
            }

            if (tokenRecord?.claimed_by) {
                return interaction.reply({ content: `❌ Token already claimed by <@${tokenRecord.claimed_by}>!`, ephemeral: true });
            }

            dbOps.claimToken(channel.id, user.id);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('token_unclaim_btn').setLabel('Unclaim').setStyle(ButtonStyle.Warning).setEmoji('🙋‍♂️')
            );

            await interaction.reply({ 
                embeds: [new EmbedBuilder().setColor(config.colors.success).setDescription(`🙋‍♂️ Token claimed by ${user}!`)],
                components: [row]
            });

            const logEmbed = new EmbedBuilder()
                .setColor(config.colors.success)
                .setTitle('🙋‍♂️ Token Claimed')
                .addFields(
                    { name: '📁 Token Channel', value: `${channel}`, inline: true },
                    { name: '👤 Staff Member', value: `${user}`, inline: true }
                )
                .setTimestamp();

            await logTokenEvent(guild, logEmbed);
        }

        if (customId === 'token_unclaim_btn') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ Only support staff can unclaim tokens.', ephemeral: true });
            }

            dbOps.unclaimToken(channel.id);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.warning).setDescription(`🙋‍♂️ Token unclaimed by ${user}.`)] });
        }

        if (customId === 'token_lock_btn') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ Only support staff can lock tokens.', ephemeral: true });
            }

            if (tokenRecord) {
                await channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: false });
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('token_unlock_btn').setLabel('Unlock').setStyle(ButtonStyle.Success).setEmoji('🔓')
            );

            await interaction.reply({ 
                embeds: [new EmbedBuilder().setColor(config.colors.danger).setDescription('🔐 **Token Locked.** Creator can no longer send messages.')],
                components: [row]
            });
        }

        if (customId === 'token_unlock_btn') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ Only support staff can unlock tokens.', ephemeral: true });
            }

            if (tokenRecord) {
                await channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: true });
            }

            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.success).setDescription('🔓 **Token Unlocked.** Creator permissions restored.')] });
        }

        if (customId === 'token_transcript_btn') {
            await interaction.deferReply();
            const attachment = await generateHtmlTranscript(channel, tokenRecord);
            await interaction.editReply({ content: '📄 Token HTML transcript generated:', files: [attachment] });
        }

        if (customId === 'token_add_user_btn') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ Only staff can add users.', ephemeral: true });
            }

            const userSelect = new UserSelectMenuBuilder()
                .setCustomId('token_add_user_select')
                .setPlaceholder('Select a user to add to this token...');

            await interaction.reply({ components: [new ActionRowBuilder().addComponents(userSelect)], ephemeral: true });
        }

        if (customId === 'token_remove_user_btn') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ Only staff can remove users.', ephemeral: true });
            }

            const userSelect = new UserSelectMenuBuilder()
                .setCustomId('token_remove_user_select')
                .setPlaceholder('Select a user to remove from this token...');

            await interaction.reply({ components: [new ActionRowBuilder().addComponents(userSelect)], ephemeral: true });
        }
    }

    // User Select Menu Handlers
    if (interaction.isUserSelectMenu()) {
        const { customId, channel, values } = interaction;
        const targetUserId = values[0];

        if (customId === 'token_add_user_select') {
            await channel.permissionOverwrites.edit(targetUserId, { ViewChannel: true, SendMessages: true });
            await interaction.reply({ content: `✅ Added <@${targetUserId}> to this token channel.` });
        }

        if (customId === 'token_remove_user_select') {
            await channel.permissionOverwrites.edit(targetUserId, { ViewChannel: false });
            await interaction.reply({ content: `🚫 Removed <@${targetUserId}> from this token channel.` });
        }
    }

    // Modal Submit Handlers
    if (interaction.isModalSubmit() && interaction.customId === 'token_close_modal') {
        const reason = interaction.fields.getTextInputValue('close_reason') || 'No reason provided';
        const tokenRecord = dbOps.getTokenByChannel(interaction.channel.id);

        if (tokenRecord) {
            await interaction.channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: false });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('token_delete_confirm_btn').setLabel('Delete Channel').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('token_reopen_btn').setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓')
        );

        await interaction.reply({ 
            embeds: [new EmbedBuilder().setColor(config.colors.danger).setDescription(`🔒 **Token Closed.** Reason: \`${reason}\``)],
            components: [row]
        });

        dbOps.updateTokenStatus(interaction.channel.id, 'closed');
    }

    if (interaction.isButton() && interaction.customId === 'token_delete_confirm_btn') {
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.danger).setDescription('🗑️ Generating transcript and purging channel...')] });
        await purgeTokenSession(interaction.channel, interaction.user);
    }

    if (interaction.isButton() && interaction.customId === 'token_reopen_btn') {
        const tokenRecord = dbOps.getTokenByChannel(interaction.channel.id);
        if (tokenRecord) {
            await interaction.channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: true });
        }

        dbOps.updateTokenStatus(interaction.channel.id, 'open');
        await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.success).setDescription('🔓 **Token Reopened!** Creator permissions restored.')] });
    }

    // Slash Command Implementations
    if (interaction.isChatInputCommand()) {
        const { commandName, channel, options, guild, user } = interaction;

        if (commandName === 'tokenadd') {
            const targetUser = options.getUser('user');
            await channel.permissionOverwrites.edit(targetUser.id, { ViewChannel: true, SendMessages: true });
            await interaction.reply({ content: `✅ Added ${targetUser} to the token.` });
        }

        if (commandName === 'tokenremove') {
            const targetUser = options.getUser('user');
            await channel.permissionOverwrites.edit(targetUser.id, { ViewChannel: false });
            await interaction.reply({ content: `🚫 Removed ${targetUser} from the token.` });
        }

        if (commandName === 'tokenrename') {
            const newName = options.getString('name');
            await channel.setName(newName);
            await interaction.reply({ content: `📝 Channel renamed to \`${newName}\`.` });
        }

        if (commandName === 'tokenclose') {
            const reason = options.getString('reason') || 'No reason provided';
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.danger).setDescription(`🔒 Token closed: **${reason}**`)] });
            await purgeTokenSession(channel, user, reason);
        }

        if (commandName === 'tokenopen') {
            const tokenRecord = dbOps.getTokenByChannel(channel.id);
            if (tokenRecord) {
                await channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: true });
            }
            dbOps.updateTokenStatus(channel.id, 'open');
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.success).setDescription('🔓 Token reopened!')] });
        }

        if (commandName === 'tokendelete') {
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.danger).setDescription('🗑️ Archiving and deleting token...')] });
            await purgeTokenSession(channel, user);
        }

        if (commandName === 'tokentranscript') {
            await interaction.deferReply();
            const tokenRecord = dbOps.getTokenByChannel(channel.id);
            const attachment = await generateHtmlTranscript(channel, tokenRecord);
            await interaction.editReply({ content: '📄 Here is the full token session transcript:', files: [attachment] });
        }

        if (commandName === 'tokenclaim') {
            dbOps.claimToken(channel.id, user.id);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.success).setDescription(`🙋‍♂️ Token claimed by ${user}!`)] });
        }

        if (commandName === 'tokenunclaim') {
            dbOps.unclaimToken(channel.id);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.warning).setDescription(`🙋‍♂️ Token unclaimed by ${user}.`)] });
        }

        if (commandName === 'tokenlock') {
            const tokenRecord = dbOps.getTokenByChannel(channel.id);
            if (tokenRecord) {
                await channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: false });
            }
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.danger).setDescription('🔐 Token locked.')] });
        }

        if (commandName === 'tokenunlock') {
            const tokenRecord = dbOps.getTokenByChannel(channel.id);
            if (tokenRecord) {
                await channel.permissionOverwrites.edit(tokenRecord.user_id, { SendMessages: true });
            }
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.success).setDescription('🔓 Token unlocked.')] });
        }

        if (commandName === 'tokenpriority') {
            const level = options.getString('level');
            dbOps.setPriority(channel.id, level);
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.warning).setDescription(`⚡ Token priority updated to **${level}**.`)] });
        }

        if (commandName === 'tokenblacklist') {
            const targetUser = options.getUser('user');
            const isNowBlacklisted = dbOps.toggleBlacklist(targetUser.id);
            if (isNowBlacklisted) {
                await interaction.reply({ content: `🚫 ${targetUser} is now blacklisted from opening tokens.` });
            } else {
                await interaction.reply({ content: `✅ Removed ${targetUser} from the blacklist.` });
            }
        }

        if (commandName === 'tokenstats') {
            const topStaff = dbOps.getStats();
            let leaderboard = '🏆 **Support Staff Leaderboard**\n\n';
            if (topStaff.length === 0) {
                leaderboard += 'No tokens resolved yet.';
            } else {
                topStaff.forEach((st, idx) => {
                    leaderboard += `**#${idx + 1}** <@${st.staff_id}>: \`${st.resolved_count}\` tokens closed\n`;
                });
            }
            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.primary).setDescription(leaderboard)] });
        }

        if (commandName === 'tokenhistory') {
            const targetUser = options.getUser('user');
            const history = dbOps.getUserTokens(targetUser.id);

            let historyText = `📜 **Token History for ${targetUser.tag}**\n\n`;
            if (history.length === 0) {
                historyText += 'No previous token history found.';
            } else {
                history.forEach(t => {
                    historyText += `• **#${t.formatted_id}** | Type: \`${t.type}\` | Status: \`${t.status}\` | Date: <t:${Math.floor(t.created_at / 1000)}:R>\n`;
                });
            }

            await interaction.reply({ embeds: [new EmbedBuilder().setColor(config.colors.primary).setDescription(historyText)], ephemeral: true });
        }
    }
});

// Login Bot
client.login(process.env.DISCORD_TOKEN);
