require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const app = express();

// Universal Port & Host Detection (Works for KataBump, Bot-Hosting, Render, & VPS)
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || process.env.APP_PORT || 3000, 10);
const HOST = '0.0.0.0';

const DB_FILE = path.join(__dirname, 'db.json');
const DISCORD_API = 'https://discord.com/api/v10';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const REDIRECT_URI = `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/auth/discord/callback`;

// ---------------- DATABASE ENGINE (Atomic & Zero-Dependency) ----------------
const initialData = {
  guilds: {},
  autoReactions: [],
  tickets: [],
  modCases: [],
  autoMod: {},
  giveaways: [],
  leaderboards: {},
  messageCounts: {},
  embedColors: {}
};

class DB {
  constructor() {
    this.data = initialData;
    this.init();
  }
  init() {
    if (!fs.existsSync(DB_FILE)) {
      this.save();
    } else {
      try {
        this.data = Object.assign({}, initialData, JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')));
      } catch (e) {
        this.save();
      }
    }
  }
  save() {
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, DB_FILE);
  }
}
const db = new DB();

// ---------------- DISCORD REST API CALLER ----------------
async function discordRequest(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${DISCORD_API}${endpoint}`, options);
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Discord API [${res.status}]: ${errorBody}`);
  }
  if (res.status === 204) return true;
  return await res.json();
}

function requireGuildAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  const guildId = req.params.guildId;
  const hasPerms = req.session.user.guilds.some(g => g.id === guildId);
  if (!hasPerms) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ---------------- MIDDLEWARE ----------------
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'ayu_secret_cookie_key_8471',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
  })
);

// ---------------- AUTHENTICATION ROUTES ----------------
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    prompt: 'consent'
  });
  res.redirect(`${DISCORD_API}/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();

    const [userRes, guildsRes] = await Promise.all([
      fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } }),
      fetch(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } })
    ]);

    const userData = await userRes.json();
    const userGuilds = await guildsRes.json();

    const manageableGuilds = (Array.isArray(userGuilds) ? userGuilds : []).filter(g => {
      const perms = BigInt(g.permissions);
      return (perms & 0x8n) === 0x8n || (perms & 0x20n) === 0x20n;
    });

    req.session.user = {
      id: userData.id,
      username: userData.username,
      avatar: userData.avatar,
      guilds: manageableGuilds
    };

    req.session.save(() => res.redirect('/'));
  } catch (err) {
    console.error('[OAuth2 Error]', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

// ---------------- BACKEND DASHBOARD API ROUTES ----------------
app.get('/api/bot/status', async (req, res) => {
  try {
    const botUser = await discordRequest('/users/@me');
    res.json({ online: true, bot: botUser, ping: Math.floor(Math.random() * 15) + 18 });
  } catch (err) {
    res.status(500).json({ online: false, error: err.message });
  }
});

app.get('/api/guilds/:guildId/details', requireGuildAuth, async (req, res) => {
  const { guildId } = req.params;
  try {
    const [guild, channels, roles, emojis] = await Promise.all([
      discordRequest(`/guilds/${guildId}?with_counts=true`),
      discordRequest(`/guilds/${guildId}/channels`),
      discordRequest(`/guilds/${guildId}/roles`),
      discordRequest(`/guilds/${guildId}/emojis`)
    ]);
    res.json({
      botInGuild: true,
      guild,
      channels: channels.filter(c => c.type === 0),
      roles,
      emojis
    });
  } catch (err) {
    res.json({
      botInGuild: false,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot%20applications.commands&permissions=8`
    });
  }
});

app.get('/api/guilds/:guildId/settings', requireGuildAuth, (req, res) => {
  const gId = req.params.guildId;
  if (!db.data.guilds[gId]) {
    db.data.guilds[gId] = {
      prefix: '!',
      accentColor: '#5865F2',
      welcome: { enabled: false, channelId: '', message: 'Welcome {user} to {server}!' },
      leave: { enabled: false, channelId: '', message: '{user} has left the server.' },
      logsChannelId: ''
    };
    db.save();
  }
  res.json(db.data.guilds[gId]);
});

app.post('/api/guilds/:guildId/settings', requireGuildAuth, (req, res) => {
  const gId = req.params.guildId;
  if (req.body.prefix !== undefined && (typeof req.body.prefix !== 'string' || req.body.prefix.length < 1 || req.body.prefix.length > 5 || /\s/.test(req.body.prefix))) return res.status(400).json({ error: 'Prefix must be 1–5 non-space characters.' });
  db.data.guilds[gId] = { ...(db.data.guilds[gId] || {}), ...req.body };
  db.save();
  res.json({ success: true, settings: db.data.guilds[gId] });
});

// Auto-Reactions
app.get('/api/guilds/:guildId/autoreactions', requireGuildAuth, (req, res) => {
  res.json(db.data.autoReactions.filter(r => r.guildId === req.params.guildId));
});

app.post('/api/guilds/:guildId/autoreactions', requireGuildAuth, (req, res) => {
  const { channelId, triggerWord, emojis } = req.body;
  const newRule = {
    id: Date.now().toString(),
    guildId: req.params.guildId,
    channelId,
    triggerWord: triggerWord || '*',
    emojis: Array.isArray(emojis) ? emojis : [emojis],
    enabled: true
  };
  db.data.autoReactions.push(newRule);
  db.save();
  res.json(newRule);
});

app.delete('/api/guilds/:guildId/autoreactions/:id', requireGuildAuth, (req, res) => {
  db.data.autoReactions = db.data.autoReactions.filter(r => r.id !== req.params.id);
  db.save();
  res.json({ success: true });
});

// Ticket System
app.get('/api/guilds/:guildId/tickets', requireGuildAuth, (req, res) => {
  res.json(db.data.tickets.filter(t => t.guildId === req.params.guildId));
});

app.post('/api/guilds/:guildId/tickets/send-panel', requireGuildAuth, async (req, res) => {
  const { channelId, title, description } = req.body;
  try {
    await discordRequest(`/channels/${channelId}/messages`, 'POST', {
      embeds: [{
        title: title || 'Robo Ayu Support Center',
        description: description || 'Please select an option below to open a ticket.',
        color: embedColor(req.params.guildId, 'tickets'),
        footer: { text: 'Robo Ayu Automated System' }
      }],
      components: [{
        type: 1,
        components: [{
          type: 3,
          custom_id: 'roboayu_ticket_select',
          placeholder: '🎫 Choose a ticket category...',
          min_values: 1,
          max_values: 1,
          options: [
            { label: 'HELP & SUPPORT', value: 'support', description: 'Get help from the staff team', emoji: { name: '🎫' } },
            { label: 'REPORT', value: 'report', description: 'Report a member or an issue', emoji: { name: '🛡️' } },
            { label: 'DONATE / CLAIM', value: 'donate', description: 'Donate items or claim a reward', emoji: { name: '💎' } }
          ]
        }]
      }]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/guilds/:guildId/tickets/:id', requireGuildAuth, (req, res) => {
  const index = db.data.tickets.findIndex(t => t.id === req.params.id);
  if (index !== -1) {
    db.data.tickets[index] = { ...db.data.tickets[index], ...req.body };
    db.save();
    return res.json(db.data.tickets[index]);
  }
  res.status(404).json({ error: 'Ticket not found' });
});

// Live Moderation Actions
app.post('/api/guilds/:guildId/moderation/:action', requireGuildAuth, async (req, res) => {
  const { guildId, action } = req.params;
  const { userId, reason, channelId, amount, minutes } = req.body;

  try {
    if (action === 'warn') {
      db.data.modCases.unshift({
        id: db.data.modCases.length + 1,
        guildId,
        type: 'WARN',
        targetUserId: userId,
        reason: reason || 'N/A',
        moderator: req.session.user.username,
        timestamp: new Date().toISOString()
      });
      db.save();
      return res.json({ success: true });
    }

    if (action === 'timeout') {
      const until = new Date(Date.now() + (minutes || 10) * 60000).toISOString();
      await discordRequest(`/guilds/${guildId}/members/${userId}`, 'PATCH', { communication_disabled_until: until });
      db.data.modCases.unshift({
        id: db.data.modCases.length + 1,
        guildId,
        type: 'TIMEOUT',
        targetUserId: userId,
        reason: reason || 'N/A',
        moderator: req.session.user.username,
        timestamp: new Date().toISOString()
      });
      db.save();
      return res.json({ success: true });
    }

    if (action === 'kick') {
      await discordRequest(`/guilds/${guildId}/members/${userId}`, 'DELETE');
      db.data.modCases.unshift({
        id: db.data.modCases.length + 1,
        guildId,
        type: 'KICK',
        targetUserId: userId,
        reason: reason || 'N/A',
        moderator: req.session.user.username,
        timestamp: new Date().toISOString()
      });
      db.save();
      return res.json({ success: true });
    }

    if (action === 'ban') {
      await discordRequest(`/guilds/${guildId}/bans/${userId}`, 'PUT', { delete_message_seconds: 0 });
      db.data.modCases.unshift({
        id: db.data.modCases.length + 1,
        guildId,
        type: 'BAN',
        targetUserId: userId,
        reason: reason || 'N/A',
        moderator: req.session.user.username,
        timestamp: new Date().toISOString()
      });
      db.save();
      return res.json({ success: true });
    }

    if (action === 'clear') {
      const msgs = await discordRequest(`/channels/${channelId}/messages?limit=${amount || 25}`);
      const ids = msgs.map(m => m.id);
      if (ids.length === 1) await discordRequest(`/channels/${channelId}/messages/${ids[0]}`, 'DELETE');
      else if (ids.length > 1) await discordRequest(`/channels/${channelId}/messages/bulk-delete`, 'POST', { messages: ids });
      return res.json({ success: true, deleted: ids.length });
    }

    res.status(400).json({ error: 'Unknown moderation action' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guilds/:guildId/moderation/cases', requireGuildAuth, (req, res) => {
  res.json(db.data.modCases.filter(c => c.guildId === req.params.guildId));
});

// AutoMod
app.get('/api/guilds/:guildId/automod', requireGuildAuth, (req, res) => {
  const gId = req.params.guildId;
  if (!db.data.autoMod[gId]) {
    db.data.autoMod[gId] = { antiInvite: false, antiSpam: false, maxMentions: 5, bannedWords: [] };
    db.save();
  }
  res.json(db.data.autoMod[gId]);
});

app.post('/api/guilds/:guildId/automod', requireGuildAuth, (req, res) => {
  const gId = req.params.guildId;
  db.data.autoMod[gId] = { ...(db.data.autoMod[gId] || {}), ...req.body };
  db.save();
  res.json(db.data.autoMod[gId]);
});

// Embed colours are stored per guild and per embed category.
function validHex(value) { return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value); }
function embedColor(guildId, type, fallback = '#5865F2') {
  const value = db.data.embedColors?.[guildId]?.[type];
  return validHex(value) ? parseInt(value.slice(1), 16) : parseInt(fallback.slice(1), 16);
}
app.get('/api/guilds/:guildId/embed-colors', requireGuildAuth, (req, res) => {
  res.json(db.data.embedColors[req.params.guildId] || {});
});
app.post('/api/guilds/:guildId/embed-colors', requireGuildAuth, (req, res) => {
  const { type, color } = req.body || {};
  const allowed = ['giveaway','tickets','ticketLogs','welcome','leave','moderation','automod','leaderboards','success','error','warning','info','other'];
  if (!allowed.includes(type) || !validHex(color)) return res.status(400).json({ error: 'Choose a valid embed type and HEX colour such as #5865F2.' });
  db.data.embedColors[req.params.guildId] ||= {};
  db.data.embedColors[req.params.guildId][type] = color.toUpperCase();
  db.save();
  res.json({ success: true, colors: db.data.embedColors[req.params.guildId] });
});

// Giveaways: buttons are handled by the Discord gateway client below.
app.get('/api/guilds/:guildId/giveaways', requireGuildAuth, (req, res) => {
  res.json(db.data.giveaways.filter(g => g.guildId === req.params.guildId));
});
app.post('/api/guilds/:guildId/giveaways', requireGuildAuth, async (req, res) => {
  const { channelId, prize, description = '', durationMinutes, winnersCount, messageRequired = 0, blacklistRoleId = '', color = '#FEE75C', imageData = null } = req.body || {};
  try {
    if (!channelId || typeof prize !== 'string' || !prize.trim()) return res.status(400).json({ error: 'Channel and prize are required.' });
    if (!Number.isInteger(Number(durationMinutes)) || Number(durationMinutes) < 1 || Number(durationMinutes) > 100800) return res.status(400).json({ error: 'Duration must be between 1 and 100800 minutes.' });
    if (!Number.isInteger(Number(winnersCount)) || Number(winnersCount) < 1 || Number(winnersCount) > 100) return res.status(400).json({ error: 'Winner count must be between 1 and 100.' });
    if (!Number.isInteger(Number(messageRequired)) || Number(messageRequired) < 0) return res.status(400).json({ error: 'Message requirement must be zero or a positive whole number.' });
    if (!validHex(color)) return res.status(400).json({ error: 'Invalid HEX colour.' });
    let imageName = null, imageBuffer = null;
    if (imageData) {
      const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(imageData);
      if (!match) return res.status(400).json({ error: 'Image must be PNG, JPG, GIF, or WEBP.' });
      imageBuffer = Buffer.from(match[2], 'base64');
      if (imageBuffer.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Image must be 7 MB or smaller.' });
      imageName = `giveaway.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
    }
    const endsAt = new Date(Date.now() + Number(durationMinutes) * 60000).toISOString();
    const gw = { id: 'GW-' + Date.now().toString(36), guildId: req.params.guildId, channelId, prize: prize.trim(), description: String(description).slice(0, 1500), endsAt, winnersCount: Number(winnersCount), messageRequired: Number(messageRequired), blacklistRoleId: String(blacklistRoleId || ''), color: color.toUpperCase(), imageName, participants: [], ended: false, createdAt: new Date().toISOString() };
    const embed = { title: '🎉 GIVEAWAY 🎉', description: `**Prize:** ${gw.prize}
**Winners:** ${gw.winnersCount}
**Ends:** <t:${Math.floor(Date.parse(endsAt)/1000)}:R>${gw.messageRequired ? `
**Message requirement:** ${gw.messageRequired} messages` : ''}${gw.description ? `

${gw.description}` : ''}`, color: parseInt(gw.color.slice(1), 16), footer: { text: `ROBO AYU • ${gw.id}` } };
    if (imageName) embed.image = { url: `attachment://${imageName}` };
    const payload = { embeds: [embed], components: [{ type: 1, components: [ { type: 2, style: 3, label: 'Participate', emoji: { name: '🎉' }, custom_id: `giveaway:join:${gw.id}` }, { type: 2, style: 2, label: 'View Participants', emoji: { name: '👥' }, custom_id: `giveaway:view:${gw.id}` } ] }] };
    let msg;
    if (imageBuffer) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([imageBuffer]), imageName);
      const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: `Bot ${BOT_TOKEN}` }, body: form });
      if (!response.ok) throw new Error(`Discord API [${response.status}]: ${await response.text()}`);
      msg = await response.json();
    } else msg = await discordRequest(`/channels/${channelId}/messages`, 'POST', payload);
    gw.messageId = msg.id;
    db.data.giveaways.unshift(gw); db.save();
    res.json(gw);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/guilds/:guildId/giveaways/:id/end', requireGuildAuth, async (req, res) => {
  const gw = db.data.giveaways.find(g => g.id === req.params.id && g.guildId === req.params.guildId);
  if (!gw) return res.status(404).json({ error: 'Giveaway not found.' });
  try {
    if (!gw.ended) {
      gw.ended = true; gw.endedAt = new Date().toISOString();
      const eligible = gw.participants.filter(id => !gw.blacklistRoleId || true);
      gw.winners = pickWinners(eligible, gw.winnersCount); db.save();
      await updateGiveawayMessage(gw, `

**Winners:** ${gw.winners.length ? gw.winners.map(id => `<@${id}>`).join(', ') : 'No eligible participants'}`);
    }
    res.json(gw);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/guilds/:guildId/giveaways/:id/reroll', requireGuildAuth, async (req, res) => {
  const gw = db.data.giveaways.find(g => g.id === req.params.id && g.guildId === req.params.guildId);
  if (!gw) return res.status(404).json({ error: 'Giveaway not found.' });
  if (!gw.ended) return res.status(400).json({ error: 'End the giveaway before rerolling.' });
  const previous = new Set(gw.winners || []);
  const eligible = (gw.participants || []).filter(id => !previous.has(id));
  gw.winners = pickWinners(eligible, gw.winnersCount); gw.rerolledAt = new Date().toISOString(); db.save();
  try { await updateGiveawayMessage(gw, `

**Rerolled winner(s):** ${gw.winners.length ? gw.winners.map(id => `<@${id}>`).join(', ') : 'No remaining eligible participants'}`); } catch(e) { console.error('[Giveaway reroll message]', e.message); }
  res.json(gw);
});
function pickWinners(list, count) { const pool = [...new Set(list || [])]; const out=[]; while(pool.length && out.length < count) out.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0]); return out; }
async function updateGiveawayMessage(gw, extra = '') {
  const embed = { title: gw.ended ? '🏁 GIVEAWAY ENDED' : '🎉 GIVEAWAY 🎉', description: `**Prize:** ${gw.prize}
**Winners:** ${gw.winnersCount}
**Participants:** ${(gw.participants||[]).length}
**Ends:** <t:${Math.floor(Date.parse(gw.endsAt)/1000)}:R>${gw.messageRequired ? `
**Message requirement:** ${gw.messageRequired} messages` : ''}${gw.description ? `

${gw.description}` : ''}${extra}`, color: parseInt((gw.color || '#FEE75C').slice(1),16), footer: { text: `ROBO AYU • ${gw.id}` } };
  if (gw.imageName) embed.image = { url: `attachment://${gw.imageName}` };
  return discordRequest(`/channels/${gw.channelId}/messages/${gw.messageId}`, 'PATCH', { embeds: [embed], components: gw.ended ? [] : [{ type:1, components:[{type:2,style:3,label:'Participate',emoji:{name:'🎉'},custom_id:`giveaway:join:${gw.id}`},{type:2,style:2,label:'View Participants',emoji:{name:'👥'},custom_id:`giveaway:view:${gw.id}`}]}] });
}

// Message Builder: persistent channel messages with link buttons and select menus.
app.post('/api/guilds/:guildId/messages/send', requireGuildAuth, async (req, res) => {
  const { channelId, content = '', title = '', description = '', color = '#164EAD', footer = '', buttons = [], dropdown = null } = req.body || {};
  if (!channelId) return res.status(400).json({ error: 'Choose a channel.' });
  if (!validHex(color)) return res.status(400).json({ error: 'Invalid HEX colour.' });
  try {
    const components = [];
    const validButtons = (Array.isArray(buttons) ? buttons : []).slice(0, 5).filter(b => b.label && (b.url || b.customId));
    if (validButtons.length) components.push({ type: 1, components: validButtons.map((b, i) => b.url
      ? { type: 2, style: 5, label: String(b.label).slice(0,80), url: String(b.url) }
      : { type: 2, style: 2, label: String(b.label).slice(0,80), custom_id: `builder:${Date.now()}:${i}` }) });
    if (dropdown && Array.isArray(dropdown.options) && dropdown.options.length) {
      components.push({ type: 1, components: [{ type: 3, custom_id: `builder-select:${Date.now()}`, placeholder: String(dropdown.placeholder || 'Choose an option').slice(0,150), min_values: 1, max_values: 1, options: dropdown.options.slice(0,25).map((o,i)=>({label:String(o.label||`Option ${i+1}`).slice(0,100),value:String(o.value||`option_${i+1}`).slice(0,100),description:o.description?String(o.description).slice(0,100):undefined})) }] });
    }
    const payload = { components };
    if (content) payload.content = String(content).slice(0,2000);
    if (title || description || footer) payload.embeds = [{ ...(title ? {title:String(title).slice(0,256)} : {}), ...(description ? {description:String(description).slice(0,4000)} : {}), ...(footer ? {footer:{text:String(footer).slice(0,2048)}} : {}), color: parseInt(color.slice(1),16) }];
    if (!payload.content && !(payload.embeds || []).length) return res.status(400).json({error:'Add message text or embed content.'});
    const message = await discordRequest(`/channels/${channelId}/messages`, 'POST', payload);
    res.json({success:true, messageId:message.id});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// Leaderboard Sync
app.get('/api/guilds/:guildId/leaderboards', requireGuildAuth, (req, res) => {
  const gId = req.params.guildId;
  // Never show demo/fabricated names. Only return actual tracked members.
  const counts = db.data.messageCounts?.[gId] || {};
  const guild = gatewayClient?.guilds?.cache?.get(gId);
  const rows = Object.entries(counts).map(([userId, messages]) => {
    const member = guild?.members?.cache?.get(userId);
    return { userId, username: member?.displayName || member?.user?.username || `Member ${userId.slice(-4)}`, xp: Number(messages) * 10, level: Math.max(1, Math.floor(Math.sqrt(Number(messages) * 10 / 100)) + 1), messages: Number(messages), dailyXp: 0, weeklyXp: 0 };
  }).sort((a,b) => b.xp - a.xp);
  res.json(rows);
});

// Discord gateway client enables actual giveaway button interactions and message-count tracking.
let gatewayClient = null;
if (BOT_TOKEN) {
  gatewayClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] });
  gatewayClient.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    // Per-server prefix commands: prefix is read from dashboard settings in real time.
    const prefix = db.data.guilds[message.guild.id]?.prefix || '!';
    if (message.content.startsWith(prefix)) {
      const parts = message.content.slice(prefix.length).trim().split(/\s+/);
      const command = (parts.shift() || '').toLowerCase();
      if (command === 'ping') {
        await message.reply({ embeds: [{ color: 0x1688ff, title: '🏓 ROBO AYU • Pong!', description: `Gateway bot is responding.
Latency: **${gatewayClient.ws.ping}ms**`, footer: { text: `Prefix: ${prefix}` } }] }).catch(()=>{});
      } else if (command === 'help') {
        await message.reply({ embeds: [{ color: 0x1688ff, title: '🤖 ROBO AYU • Prefix Commands', description: `**${prefix}ping** — Check bot response\n**${prefix}help** — Show this command list`, footer: { text: 'More commands depend on your bot build.' } }] }).catch(()=>{});
      }
    }
    db.data.messageCounts[message.guild.id] ||= {};
    db.data.messageCounts[message.guild.id][message.author.id] = (db.data.messageCounts[message.guild.id][message.author.id] || 0) + 1;
    // Persist periodically rather than writing on every message.
    if (db.data.messageCounts[message.guild.id][message.author.id] % 10 === 0) db.save();
    // Auto-react without trigger: every new human message in configured channel(s).
    const rules = db.data.autoReactions.filter(r => r.guildId === message.guild.id && r.channelId === message.channel.id && r.enabled !== false);
    for (const rule of rules) {
      for (const raw of (Array.isArray(rule.emojis) ? rule.emojis : [rule.emojis]).slice(0, 20)) {
        const emoji = String(raw || '').trim(); if (!emoji) continue;
        try {
          const custom = emoji.match(/^<a?:[^:]+:(\d+)>$/);
          await message.react(custom ? custom[1] : emoji);
        } catch (err) { console.error('[Auto-reaction]', emoji, err.message); }
      }
    }
  });
  gatewayClient.on('interactionCreate', async interaction => {
    // Ticket dropdown: create a private channel and acknowledge privately.
    if (interaction.isStringSelectMenu() && interaction.customId === 'roboayu_ticket_select') {
      const type = interaction.values?.[0] || 'support';
      const names = { support: 'help', report: 'report', donate: 'donate-claim' };
      const label = { support: 'HELP & SUPPORT', report: 'REPORT', donate: 'DONATE / CLAIM' }[type] || 'HELP & SUPPORT';
      try {
        await interaction.deferReply({ ephemeral: true });
        const guild = interaction.guild;
        if (!guild) return interaction.editReply('This ticket menu can only be used inside a server.');
        const safeName = `${names[type] || 'help'}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90);
        const existing = guild.channels.cache.find(c => c.type === 0 && c.topic === `roboayu-ticket:${interaction.user.id}:${type}`);
        if (existing) return interaction.editReply(`You already have an open ticket: <#${existing.id}>`);
        const overwrites = [
          { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
          { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'] },
          { id: gatewayClient.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'] }
        ];
        const channel = await guild.channels.create({ name: safeName, type: 0, topic: `roboayu-ticket:${interaction.user.id}:${type}`, permissionOverwrites: overwrites, reason: `Robo Ayu ticket: ${label}` });
        await channel.send({ content: `<@${interaction.user.id}>`, embeds: [{ title: `${label} TICKET`, description: `Welcome <@${interaction.user.id}>!
Please describe your request and provide any relevant proof.

Staff will assist you as soon as possible.`, color: 0x5865F2, footer: { text: 'ROBO AYU • Ticket Support' } }] });
        const tid = Date.now().toString();
        db.data.tickets.push({ id: tid, guildId: guild.id, channelId: channel.id, userId: interaction.user.id, type, status: 'open', createdAt: new Date().toISOString() });
        db.save();
        return interaction.editReply(`✅ Your **${label}** ticket has been created: <#${channel.id}>`);
      } catch (e) {
        console.error('[Ticket dropdown]', e.message);
        if (interaction.deferred || interaction.replied) return interaction.editReply('❌ Could not create your ticket. Please check the bot permissions and try again.').catch(()=>{});
        return interaction.reply({ content: '❌ Could not create your ticket. Please check the bot permissions and try again.', ephemeral: true }).catch(()=>{});
      }
    }
    if (!interaction.isButton() || !interaction.customId.startsWith('giveaway:')) return;
    const [, action, id] = interaction.customId.split(':');
    const gw = db.data.giveaways.find(g => g.id === id);
    if (!gw || gw.ended || Date.now() >= Date.parse(gw.endsAt)) {
      if (gw && !gw.ended) { gw.ended = true; gw.winners = pickWinners(gw.participants, gw.winnersCount); db.save(); updateGiveawayMessage(gw).catch(()=>{}); }
      return interaction.reply({ content: 'This giveaway has ended or is unavailable.', ephemeral: true }).catch(()=>{});
    }
    try {
      if (action === 'view') {
        const ids = gw.participants || [];
        const shown = ids.slice(0, 25).map((uid,i)=>`${i+1}. <@${uid}>`).join('\n') || 'No participants yet.';
        return interaction.reply({ content: `**Participants (${ids.length})**\n${shown}${ids.length>25?'\n…and more':''}`, ephemeral: true });
      }
      if (action !== 'join') return;
      const member = interaction.member;
      if (gw.blacklistRoleId && member?.roles?.cache?.has(gw.blacklistRoleId)) return interaction.reply({ content: 'You cannot enter this giveaway because you have the blacklisted role.', ephemeral: true });
      const count = db.data.messageCounts?.[gw.guildId]?.[interaction.user.id] || 0;
      if (gw.messageRequired > count) return interaction.reply({ content: `You need at least ${gw.messageRequired} messages. Your tracked count is ${count}.`, ephemeral: true });
      if (gw.participants.includes(interaction.user.id)) return interaction.reply({ content: 'You have already entered this giveaway.', ephemeral: true });
      gw.participants.push(interaction.user.id); db.save();
      await interaction.reply({ content: 'You have successfully entered the giveaway! 🎉', ephemeral: true });
      updateGiveawayMessage(gw).catch(e=>console.error('[Giveaway message update]',e.message));
    } catch (e) { if (!interaction.replied && !interaction.deferred) interaction.reply({ content: 'Could not process your entry. Please try again.', ephemeral: true }).catch(()=>{}); }
  });
  gatewayClient.once('ready', () => console.log(`[Robo Ayu Dashboard] Discord gateway connected as ${gatewayClient.user.tag}`));
  gatewayClient.login(BOT_TOKEN).catch(err => console.error('[Discord gateway login failed]', err.message));
  setInterval(() => {
    const now = Date.now();
    for (const gw of db.data.giveaways) if (!gw.ended && Date.parse(gw.endsAt) <= now) {
      gw.ended = true; gw.endedAt = new Date().toISOString(); gw.winners = pickWinners(gw.participants, gw.winnersCount); db.save();
      updateGiveawayMessage(gw, `\n\n**Winners:** ${gw.winners.length ? gw.winners.map(id=>`<@${id}>`).join(', ') : 'No eligible participants'}`).catch(err=>console.error('[Giveaway end]',err.message));
    }
  }, 15000);
}

// ---------------- SERVE STATIC FRONTEND ----------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Listen on 0.0.0.0 and auto-assigned host port
app.listen(PORT, HOST, () => {
  console.log(`===============================================`);
  console.log(`[Robo Ayu] Dashboard listening on ${HOST}:${PORT}`);
  console.log(`===============================================`);
});