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
    AttachmentBuilder,
    UserSelectMenuBuilder
} = require('discord.js');
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ==========================================
// 0. CONFIGURATION SECTION
// ==========================================
const config = {
    prefix: "token-",
    maxOpenTokens: 1,
    tokenCooldown: 30, // seconds
    autoTranscript: true,
    colors: {
        primary: "#5865F2",
        success: "#57F287",
        warning: "#FEE75C",
        danger: "#ED4245",
        dark: "#2B2D31"
    },
    categories: [
        { label: "General Support", value: "general", emoji: "💬", description: "General inquiries & assistance" },
        { label: "Purchase Support", value: "purchase", emoji: "💰", description: "Store & billing inquiries" },
        { label: "Bug Report", value: "bug", emoji: "🐛", description: "Report glitches or technical issues" },
        { label: "Player Report", value: "report", emoji: "🚨", description: "Report rule-breaking players" },
        { label: "Punishment Appeal", value: "appeal", emoji: "🔨", description: "Appeal bans or mutes" },
        { label: "Suggestions", value: "suggestion", emoji: "💡", description: "Share server ideas & feedback" },
        { label: "Partnership", value: "partnership", emoji: "🤝", description: "Inquire about business or partnerships" }
    ]
};

// ==========================================
// 1. KEEP-ALIVE WEB SERVER (UNTOUCHED)
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Bot is online!'));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Keep-alive server running.'));

// ==========================================
// 2. PERSISTENT SQLITE DATABASE INITIALIZATION
// ==========================================
const db = new Database('tokens.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
        guild_id TEXT PRIMARY KEY,
        support_role_id TEXT,
        staff_role_id TEXT,
        category_id TEXT,
        logs_channel_id TEXT,
        transcript_channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS tokens (
        token_id INTEGER PRIMARY KEY AUTOINCREMENT,
        formatted_id TEXT,
        channel_id TEXT UNIQUE,
        guild_id TEXT,
        user_id TEXT,
        type TEXT,
        status TEXT DEFAULT 'open',
        claimed_by TEXT,
        priority TEXT DEFAULT 'Normal',
        reason TEXT,
        created_at INTEGER,
        closed_at INTEGER,
        closed_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS blacklists (
        user_id TEXT PRIMARY KEY,
        reason TEXT,
        added_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS stats (
        staff_id TEXT PRIMARY KEY,
        resolved_count INTEGER DEFAULT 0
    );
`);

// Cooldown tracker (In-Memory)
const cooldowns = new Map();
const tempAnnounceData = new Map();
const autoResponders = new Map();

// Helper Functions for Database Operations
const dbOps = {
    getConfig: (guildId) => db.prepare('SELECT * FROM guild_configs WHERE guild_id = ?').get(guildId),
    setConfig: (guildId, supportRoleId, staffRoleId, categoryId, logsChannelId, transcriptChannelId) => {
        return db.prepare(`
            INSERT INTO guild_configs (guild_id, support_role_id, staff_role_id, category_id, logs_channel_id, transcript_channel_id)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
                support_role_id = excluded.support_role_id,
                staff_role_id = excluded.staff_role_id,
                category_id = excluded.category_id,
                logs_channel_id = excluded.logs_channel_id,
                transcript_channel_id = excluded.transcript_channel_id
        `).run(guildId, supportRoleId, staffRoleId, categoryId, logsChannelId, transcriptChannelId);
    },
    createTokenRecord: (formattedId, channelId, guildId, userId, type, reason) => {
        return db.prepare(`
            INSERT INTO tokens (formatted_id, channel_id, guild_id, user_id, type, status, reason, created_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
        `).run(formattedId, channelId, guildId, userId, type, reason, Date.now());
    },
    getTokenByChannel: (channelId) => db.prepare('SELECT * FROM tokens WHERE channel_id = ?').get(channelId),
    getActiveUserTokens: (userId) => db.prepare("SELECT * FROM tokens WHERE user_id = ? AND status != 'deleted' AND status != 'closed'").all(userId),
    getUserTokens: (userId) => db.prepare('SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(userId),
    updateTokenStatus: (channelId, status) => db.prepare('UPDATE tokens SET status = ? WHERE channel_id = ?').run(status, channelId),
    claimToken: (channelId, staffId) => db.prepare('UPDATE tokens SET claimed_by = ? WHERE channel_id = ?').run(staffId, channelId),
    unclaimToken: (channelId) => db.prepare('UPDATE tokens SET claimed_by = NULL WHERE channel_id = ?').run(channelId),
    setPriority: (channelId, priority) => db.prepare('UPDATE tokens SET priority = ? WHERE channel_id = ?').run(priority, channelId),
    closeToken: (channelId, reason) => db.prepare("UPDATE tokens SET status = 'closed', closed_at = ?, closed_reason = ? WHERE channel_id = ?").run(Date.now(), reason, channelId),
    getNextTokenId: () => {
        const row = db.prepare('SELECT MAX(token_id) as maxId FROM tokens').get();
        return (row?.maxId || 0) + 1;
    },
    isBlacklisted: (userId) => !!db.prepare('SELECT 1 FROM blacklists WHERE user_id = ?').get(userId),
    toggleBlacklist: (userId) => {
        if (dbOps.isBlacklisted(userId)) {
            db.prepare('DELETE FROM blacklists WHERE user_id = ?').run(userId);
            return false;
        } else {
            db.prepare('INSERT INTO blacklists (user_id, added_at) VALUES (?, ?)').run(userId, Date.now());
            return true;
        }
    },
    incrementStaffStat: (staffId) => {
        return db.prepare(`
            INSERT INTO stats (staff_id, resolved_count) VALUES (?, 1)
            ON CONFLICT(staff_id) DO UPDATE SET resolved_count = resolved_count + 1
        `).run(staffId);
    },
    getStats: () => db.prepare('SELECT * FROM stats ORDER BY resolved_count DESC LIMIT 10').all()
};

function isValidUrl(urlString) {
    if (!urlString) return false;
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// ==========================================
// 3. INITIALIZE DISCORD CLIENT
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel, Partials.Message]
});

// ==========================================
// 4. SLASH COMMAND REGISTRATION
// ==========================================
const commands = [
    // Non-token commands (UNTOUCHED)
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

    // --- REBRANDED & UPDATED /TOKEN SYSTEM COMMANDS ---
    new SlashCommandBuilder()
        .setName('tokensetup')
        .setDescription('Send the token support portal to a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel for the portal').setRequired(true))
        .addRoleOption(opt => opt.setName('support_role').setDescription('Primary support role').setRequired(true))
        .addRoleOption(opt => opt.setName('staff_role').setDescription('Additional staff role (Optional)'))
        .addChannelOption(opt => opt.setName('category').setDescription('Category channel for tokens').addChannelTypes(ChannelType.GuildCategory))
        .addChannelOption(opt => opt.setName('logs_channel').setDescription('Channel for token event logs').addChannelTypes(ChannelType.GuildText))
        .addChannelOption(opt => opt.setName('transcript_channel').setDescription('Channel for HTML transcripts').addChannelTypes(ChannelType.GuildText)),

    new SlashCommandBuilder()
        .setName('tokenpanel')
        .setDescription('Post the token creation panel in the current channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('tokenadd')
        .setDescription('Add a user to this active token')
        .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true)),

    new SlashCommandBuilder()
        .setName('tokenremove')
        .setDescription('Remove a user from this active token')
        .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true)),

    new SlashCommandBuilder()
        .setName('tokenrename')
        .setDescription('Rename the active token channel')
        .addStringOption(opt => opt.setName('name').setDescription('New channel name').setRequired(true)),

    new SlashCommandBuilder()
        .setName('tokenclose')
        .setDescription('Close and archive the current token')
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for closing token')),

    new SlashCommandBuilder()
        .setName('tokenopen')
        .setDescription('Reopen a closed token'),

    new SlashCommandBuilder()
        .setName('tokendelete')
        .setDescription('Delete token channel and generate transcript')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('tokentranscript')
        .setDescription('Generate full transcript of this token session'),

    new SlashCommandBuilder()
        .setName('tokenclaim')
        .setDescription('Claim this token as staff'),

    new SlashCommandBuilder()
        .setName('tokenunclaim')
        .setDescription('Unclaim this token'),

    new SlashCommandBuilder()
        .setName('tokenlock')
        .setDescription('Lock this token from user messages'),

    new SlashCommandBuilder()
        .setName('tokenunlock')
        .setDescription('Unlock this token for user messages'),

    new SlashCommandBuilder()
        .setName('tokenpriority')
        .setDescription('Set the priority level of this token')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption(opt => opt.setName('level').setDescription('Priority level').setRequired(true)
            .addChoices(
                { name: '🟢 Low', value: 'Low' },
                { name: '🟡 Normal', value: 'Normal' },
                { name: '🟠 High', value: 'High' },
                { name: '🔴 Urgent', value: 'Urgent' }
            )),

    new SlashCommandBuilder()
        .setName('tokenblacklist')
        .setDescription('Toggle blacklist status for a user')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(opt => opt.setName('user').setDescription('User to toggle').setRequired(true)),

    new SlashCommandBuilder()
        .setName('tokenstats')
        .setDescription('View support staff performance statistics')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('tokenhistory')
        .setDescription("View a user's previous token history")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addUserOption(opt => opt.setName('user').setDescription('Target user').setRequired(true))
].map(cmd => cmd.toJSON());

// Ready Event
client.once('clientReady', async () => {
    console.log(`Bot online as ${client.user.tag}`);
    console.log('Database connected & tables initialized.');
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log('Slash commands registered successfully!');
        console.log('Token system loaded & ready.');
    } catch (err) {
        console.error('Error registering slash commands:', err);
    }
});

// ==========================================
// 5. ADVANCED HTML TRANSCRIPT & LOGGING ENGINE
// ==========================================
async function generateHtmlTranscript(channel, tokenRecord) {
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

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Transcript #${tokenRecord?.formatted_id || channel.name}</title>
        <style>
            body { background-color: #1e1f22; color: #dcddde; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; }
            .header { background-color: #2b2d31; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 5px solid #5865f2; }
            .header h1 { margin: 0 0 10px 0; color: #fff; font-size: 24px; }
            .info { font-size: 14px; color: #b5bac1; }
            .message { display: flex; margin-bottom: 15px; background: #2b2d31; padding: 10px 15px; border-radius: 6px; }
            .avatar { width: 40px; height: 40px; border-radius: 50%; margin-right: 15px; }
            .content { flex-grow: 1; }
            .author { font-weight: bold; color: #fff; margin-bottom: 3px; }
            .timestamp { font-size: 11px; color: #949ba4; margin-left: 8px; font-weight: normal; }
            .text { font-size: 15px; line-height: 1.4; color: #dbdee1; white-space: pre-wrap; }
            .attachment { margin-top: 8px; }
            .attachment a { color: #00a8fc; text-decoration: none; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>Token Transcript #${tokenRecord?.formatted_id || channel.name}</h1>
            <div class="info">
                <strong>Type:</strong> ${tokenRecord?.type || 'N/A'} | 
                <strong>Opened By ID:</strong> ${tokenRecord?.user_id || 'Unknown'} | 
                <strong>Generated On:</strong> ${new Date().toUTCString()}
            </div>
        </div>
        <div class="messages">
    `;

    messages.forEach(msg => {
        const avatar = msg.author.displayAvatarURL({ format: 'png', dynamic: true, size: 64 });
        const timestamp = msg.createdAt.toISOString().replace('T', ' ').substring(0, 19);
        const textContent = msg.content ? msg.content.replace(/</g, "&lt;").replace(/>/g, "&gt;") : '';

        html += `
            <div class="message">
                <img class="avatar" src="${avatar}" alt="Avatar">
                <div class="content">
                    <div class="author">${msg.author.tag} <span class="timestamp">${timestamp}</span></div>
                    ${textContent ? `<div class="text">${textContent}</div>` : ''}
        `;

        if (msg.attachments.size > 0) {
            msg.attachments.forEach(att => {
                html += `<div class="attachment">📎 <a href="${att.url}" target="_blank">${att.name}</a></div>`;
            });
        }

        html += `</div></div>`;
    });

    html += `</div></body></html>`;

    const buffer = Buffer.from(html, 'utf-8');
    return new AttachmentBuilder(buffer, { name: `transcript-${channel.name}.html` });
}

async function logTokenEvent(guild, embed) {
    const configData = dbOps.getConfig(guild.id);
    if (!configData || !configData.logs_channel_id) return;

    const logChannel = guild.channels.cache.get(configData.logs_channel_id);
    if (logChannel) {
        try {
            await logChannel.send({ embeds: [embed] });
        } catch (e) {
            console.error('Failed to send log event:', e);
        }
    }
}

async function purgeTokenSession(channel, closedBy, reason = 'No reason provided') {
    const guild = channel.guild;
    const tokenRecord = dbOps.getTokenByChannel(channel.id);
    const attachment = await generateHtmlTranscript(channel, tokenRecord);

    if (tokenRecord) {
        dbOps.closeToken(channel.id, reason);
    }

    if (closedBy && !closedBy.bot) {
        dbOps.incrementStaffStat(closedBy.id);
    }

    const logEmbed = new EmbedBuilder()
        .setColor(config.colors.danger)
        .setTitle('🔒 Token Closed & Archived')
        .addFields(
            { name: '📁 Token Channel', value: `\`${channel.name}\``, inline: true },
            { name: '👤 Closed By', value: `${closedBy}`, inline: true },
            { name: '👤 Token Creator', value: tokenRecord ? `<@${tokenRecord.user_id}>` : 'Unknown', inline: true },
            { name: '📝 Closing Reason', value: `\`\`\`${reason}\`\`\``, inline: false }
        )
        .setTimestamp();

    await logTokenEvent(guild, logEmbed);

    const configData = dbOps.getConfig(guild.id);
    if (configData && configData.transcript_channel_id) {
        const transcriptChannel = guild.channels.cache.get(configData.transcript_channel_id);
        if (transcriptChannel) {
            try {
                await transcriptChannel.send({ embeds: [logEmbed], files: [attachment] });
            } catch (e) {}
        }
    }

    if (tokenRecord) {
        try {
            const user = await client.users.fetch(tokenRecord.user_id);
            if (user) {
                await user.send({
                    content: `📄 Here is your official transcript log for your token in **${guild.name}**:`,
                    embeds: [logEmbed],
                    files: [attachment]
                });
            }
        } catch (e) {}
    }

    dbOps.updateTokenStatus(channel.id, 'deleted');
    setTimeout(() => channel.delete().catch(() => {}), 3000);
}

// ==========================================
// 6. AUTO-RESPONDER ENGINE (UNTOUCHED)
// ==========================================
client.on('messageCreate', (msg) => {
    if (msg.author.bot) return;
    const trigger = msg.content.toLowerCase();
    if (autoResponders.has(trigger)) {
        msg.reply(autoResponders.get(trigger));
    }
});

// ==========================================
// 7. TOKEN CHANNEL CREATOR
// ==========================================
async function createTokenChannel(interaction, categoryValue, reason) {
    const guild = interaction.guild;
    const user = interaction.user;

    if (dbOps.isBlacklisted(user.id)) {
        return interaction.reply({ content: '❌ You are blacklisted from opening tokens.', ephemeral: true });
    }

    const now = Date.now();
    const cooldownTime = (config.tokenCooldown || 30) * 1000;
    if (cooldowns.has(user.id)) {
        const expirationTime = cooldowns.get(user.id) + cooldownTime;
        if (now < expirationTime) {
            const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
            return interaction.reply({ content: `⏳ Please wait **${timeLeft}s** before opening another token.`, ephemeral: true });
        }
    }

    const activeTokens = dbOps.getActiveUserTokens(user.id);
    if (activeTokens.length >= config.maxOpenTokens) {
        const openChannel = guild.channels.cache.get(activeTokens[0].channel_id);
        return interaction.reply({ 
            content: `❌ You already have an active token open: ${openChannel ? openChannel : 'in another channel'}.`, 
            ephemeral: true 
        });
    }

    cooldowns.set(user.id, now);

    const configData = dbOps.getConfig(guild.id) || {};
    let supportRole = configData.support_role_id ? guild.roles.cache.get(configData.support_role_id) : null;
    let staffRole = configData.staff_role_id ? guild.roles.cache.get(configData.staff_role_id) : null;

    if (!supportRole) {
        supportRole = guild.roles.cache.find(r => r.name.toLowerCase().includes('support') || r.name.toLowerCase().includes('staff')) || guild.roles.everyone;
    }

    let category = configData.category_id ? guild.channels.cache.get(configData.category_id) : null;
    if (!category) {
        category = guild.channels.cache.find(c => c.name.toLowerCase() === 'tokens' && c.type === ChannelType.GuildCategory);
        if (!category) {
            try {
                category = await guild.channels.create({ name: 'Tokens', type: ChannelType.GuildCategory });
            } catch (e) {
                category = null;
            }
        }
    }

    const nextId = dbOps.getNextTokenId();
    const formattedId = String(nextId).padStart(4, '0');
    const channelName = `${config.prefix}${formattedId}`;

    const permissionOverwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
        { id: supportRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] }
    ];

    if (staffRole) {
        permissionOverwrites.push({ id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] });
    }

    try {
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category ? category.id : null,
            permissionOverwrites
        });

        dbOps.createTokenRecord(formattedId, channel.id, guild.id, user.id, categoryValue, reason);

        const tokenEmbed = new EmbedBuilder()
            .setColor(config.colors.primary)
            .setTitle(`🎫 Support Token | #${formattedId}`)
            .setDescription(`Welcome ${user}! Support staff will be with you shortly.\n\nUse the panel buttons below to manage this token session.`)
            .addFields(
                { name: '👤 Creator', value: `${user}`, inline: true },
                { name: '📌 Category', value: `\`${categoryValue.toUpperCase()}\``, inline: true },
                { name: '⚡ Priority', value: '`Normal`', inline: true },
                { name: '🙋‍♂️ Claimed By', value: '`Unclaimed`', inline: true },
                { name: '📝 Reason / Details', value: `\`\`\`${reason}\`\`\``, inline: false }
            )
            .setFooter({ text: `Token ID: #${formattedId} • R.O.T.I Support Engine`, iconURL: guild.iconURL() || undefined })
            .setTimestamp();

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('token_close_btn').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
            new ButtonBuilder().setCustomId('token_claim_btn').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋‍♂️'),
            new ButtonBuilder().setCustomId('token_lock_btn').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔐'),
            new ButtonBuilder().setCustomId('token_transcript_btn').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄')
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('token_add_user_btn').setLabel('Add User').setStyle(ButtonStyle.Primary).setEmoji('➕'),
            new ButtonBuilder().setCustomId('token_remove_user_btn').setLabel('Remove User').setStyle(ButtonStyle.Secondary).setEmoji('➖')
        );

        await channel.send({ content: `${user} | ${supportRole}`, embeds: [tokenEmbed], components: [row1, row2] });
        await interaction.reply({ content: `✅ Token created! Head over to ${channel}`, ephemeral: true });

        const logEmbed = new EmbedBuilder()
            .setColor(config.colors.success)
            .setTitle('🎫 Token Created')
            .addFields(
                { name: '📁 Token Channel', value: `${channel}`, inline: true },
                { name: '👤 Creator', value: `${user}`, inline: true },
                { name: '📌 Category', value: `\`${categoryValue}\``, inline: true }
            )
            .setTimestamp();

        await logTokenEvent(guild, logEmbed);

    } catch (err) {
        console.error('Error creating token channel:', err);
        await interaction.reply({ content: '❌ Failed to create token channel. Please check bot permissions.', ephemeral: true });
    }
}

// ==========================================
// 8. ROUTER FOR ALL INTERACTIONS
// ==========================================
client.on('interactionCreate', async (interaction) => {

    // --- Command: /announce (UNTOUCHED) ---
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

    // --- Command: /autorespond (UNTOUCHED) ---
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
    // TOKEN SYSTEM INTERACTIONS
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

    // Button Router
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
