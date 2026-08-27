require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const commands = [
  // /buttonbuilder Command
  new SlashCommandBuilder()
    .setName('buttonbuilder')
    .setDescription('Create a custom interactive button message')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // /announce Command
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Create and post a custom embed announcement')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption(option => 
      option.setName('channel').setDescription('Channel to send announcement').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(option => 
      option.setName('title').setDescription('Embed Title').setRequired(false))
    .addStringOption(option => 
      option.setName('color').setDescription('Hex Color (e.g., #FF5733)').setRequired(false))
    .addStringOption(option => 
      option.setName('author_name').setDescription('Author Name').setRequired(false))
    .addStringOption(option => 
      option.setName('author_icon').setDescription('Author Icon URL').setRequired(false))
    .addStringOption(option => 
      option.setName('thumbnail').setDescription('Thumbnail Image URL').setRequired(false))
    .addStringOption(option => 
      option.setName('field1_title').setDescription('Field 1 Header').setRequired(false))
    .addStringOption(option => 
      option.setName('field2_title').setDescription('Field 2 Header').setRequired(false))
    .addStringOption(option => 
      option.setName('field3_title').setDescription('Field 3 Header').setRequired(false))
    .addStringOption(option => 
      option.setName('footer_text').setDescription('Footer Text').setRequired(false))
    .addStringOption(option => 
      option.setName('footer_icon').setDescription('Footer Icon URL').setRequired(false))
    .addBooleanOption(option => 
      option.setName('send_dm').setDescription('Send DM copy to server members?').setRequired(false)),

  // /autorespond Command
  new SlashCommandBuilder()
    .setName('autorespond')
    .setDescription('Set up an automated message trigger')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(option => 
      option.setName('trigger').setDescription('Word/phrase to trigger reply').setRequired(true))
    .addStringOption(option => 
      option.setName('reply').setDescription('Message the bot sends back').setRequired(true))
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering Slash Commands to Discord...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash Commands successfully registered globally!');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
})();
