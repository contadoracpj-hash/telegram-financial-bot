import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pg from 'pg';
import { formatCurrency, getPeriodFilter } from './utils.js';
import http from 'http';
const { Pool } = pg;

// Almacena estados temporales de usuarios: { chatId: { action: 'renaming', catId: number } }
const userStates: Record<number, { action: string, catId?: number }> = {};

// verify .env
if (!process.env.BOT_TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN no encontrado en el archivo .env");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("❌ ERROR: DATABASE_URL no encontrada en el archivo .env");
  process.exit(1);
}

// db config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// immediate db connection test
pool.connect()
  .then(() => console.log("✅ Conexión a Base de Datos establecida"))
  .catch((err) => {
    console.error("❌ Error conectando a la BD:", err.message);
    process.exit(1);
  });

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- COMANDOS ---
bot.command('categoria', async (ctx) => {
  const name = ctx.payload;
  if (!name) return ctx.reply('Uso: /categoria [nombre]');
  await pool.query('INSERT INTO categories (name) VALUES ($1)', [name]);
  ctx.reply(`✅ Categoría "${name}" agregada.`);
});

bot.command('editar', async (ctx) => {
  const id = ctx.payload;
  if (!id) return ctx.reply('Uso: /editar [ID_GASTO]');
  
  const { rows } = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  if (rows.length === 0) return ctx.reply('❌ Gasto no encontrado.');

  const cats = await pool.query('SELECT * FROM categories');
  const buttons = cats.rows.map(c => [Markup.button.callback(c.name, `edit_cat_${c.id}_${id}`)]);
  
  ctx.reply(`Moviendo gasto [ID:${id}]. ¿Nueva categoría?`, Markup.inlineKeyboard(buttons));
});

bot.command('eliminar', async (ctx) => {
  const id = ctx.payload;
  if (!id) return ctx.reply('Uso: /eliminar [ID]');
  const res = await pool.query('DELETE FROM expenses WHERE id = $1', [id]);
  ctx.reply(res.rowCount! > 0 ? `✅ Gasto ID ${id} eliminado.` : '❌ ID no encontrado.');
});

bot.command('resumen', (ctx) => {
  ctx.reply('📅 Elige el periodo:', Markup.inlineKeyboard([
    [Markup.button.callback('Este Mes', 'per_mes'), Markup.button.callback('Esta Semana', 'per_sem')],
    [Markup.button.callback('Histórico', 'per_todo')]
  ]));
});

bot.command('renombrarcategoria', async (ctx) => {
  const { rows } = await pool.query('SELECT * FROM categories');
  if (rows.length === 0) return ctx.reply('📭 No hay categorías para renombrar.');
  
  const buttons = rows.map(c => [Markup.button.callback(`Renombrar: ${c.name}`, `rename_start_${c.id}`)]);
  ctx.reply('🏷️ ¿Qué categoría querés renombrar?', Markup.inlineKeyboard(buttons));
});

bot.command('eliminarcategoria', async (ctx) => {
  const { rows } = await pool.query('SELECT * FROM categories');
  if (rows.length === 0) return ctx.reply('📭 No hay categorías para eliminar.');
  
  const buttons = rows.map(c => [Markup.button.callback(`Eliminar: ${c.name}`, `del_cat_${c.id}`)]);
  ctx.reply('⚠️ ¿Qué categoría querés eliminar?', Markup.inlineKeyboard(buttons));
});

bot.command('categorias', async (ctx) => {
  const { rows } = await pool.query('SELECT name FROM categories ORDER BY name ASC');
  if (rows.length === 0) return ctx.reply('📭 No tienes categorías.');
  const lista = rows.map(c => `• ${c.name}`).join('\n');
  ctx.reply(`🏷️ *Tus categorías actuales:*\n\n${lista}`, { parse_mode: 'Markdown' });
});

bot.command('ayuda', (ctx) => {
  const msg = `🤖 *Guía de uso:*
• /categorias - Lista categorías.
• /categoria [nombre] - Crear categoría.
• /renombrarcategoria - Renombrar una existente.
• /eliminarcategoria - Borrar una existente.
• /resumen - Ver reportes.
• /editar [ID] - Cambiar categoría de un gasto.
• /eliminar [ID] - Borrar gasto.
• /ayuda - Este mensaje.`;
  ctx.replyWithMarkdown(msg);
});

bot.start((ctx) => {
  ctx.reply("¡Hola! Soy tu bot de finanzas. Usa /ayuda si tienes dudas.");
});

// --- INTERCEPTOR DE TEXTO (Para estados como renombrar) ---
bot.on('text', async (ctx, next) => {
  const userId = ctx.chat.id;
  if (userStates[userId] && userStates[userId].action === 'renaming') {
    const nuevoNombre = ctx.message.text;
    await pool.query('UPDATE categories SET name = $1 WHERE id = $2', [nuevoNombre, userStates[userId].catId]);
    delete userStates[userId];
    return ctx.reply(`✅ Categoría renombrada a "${nuevoNombre}".`);
  }
  return next();
});

// --- HEARS Y CALLBACKS ---
bot.hears(/^(\d+(?:\.\d+)?)\s+(.+)$|^(.+)\s+(\d+(?:\.\d+)?)$/, async (ctx) => {
  const match = ctx.match;
  const amount = parseFloat(match[1] || match[4]);
  const description = (match[2] || match[3]).trim();
  const res = await pool.query('INSERT INTO temp_pending_expenses(amount, description) VALUES($1, $2) RETURNING id', [amount, description]);
  const { rows } = await pool.query('SELECT * FROM categories');
  if (rows.length === 0) return ctx.reply('❌ Crea primero una categoría con /categoria.');
  const buttons = rows.map(c => [Markup.button.callback(c.name, `cat_sel_${c.id}_${res.rows[0].id}`)]);
  ctx.reply(`Gasto: $${amount} (${description}). ¿Categoría?`, Markup.inlineKeyboard(buttons));
});

bot.action(/^(per|cat_sel|cat_fil|edit_cat|rename_start|del_cat)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const type = ctx.match[1];
  const payload = ctx.match[2];

  if (type === 'per') {
    const { rows } = await pool.query('SELECT name FROM categories');
    const buttons = rows.map(c => [Markup.button.callback(`Solo ${c.name}`, `cat_fil_${payload}_${c.name}`)]);
    buttons.push([Markup.button.callback('Todas', `cat_fil_${payload}_todas`)]);
    ctx.editMessageText('🏷️ Elige:', Markup.inlineKeyboard(buttons));
  } else if (type === 'cat_sel') {
    const [catId, tempId] = payload.split('_');
    const temp = await pool.query('DELETE FROM temp_pending_expenses WHERE id = $1 RETURNING *', [tempId]);
    if (temp.rows.length > 0) {
      await pool.query('INSERT INTO expenses(amount, description, category_id) VALUES($1, $2, $3)', [temp.rows[0].amount, temp.rows[0].description, catId]);
      ctx.editMessageText('✅ Gasto registrado.');
    }
  } else if (type === 'cat_fil') {
    const [period, category] = payload.split('_');
    const dateFilter = getPeriodFilter(period);
    let query = `SELECT e.id, e.amount, e.description, c.name as category FROM expenses e JOIN categories c ON e.category_id = c.id WHERE ${dateFilter}`;
    if (category !== 'todas') query += ` AND c.name = '${category}'`;
    query += ` ORDER BY e.created_at DESC LIMIT 10`;
    const { rows } = await pool.query(query);
    const total = rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    let msg = `📊 *Resultado (${period} / ${category}):*\n\n`;
    if (rows.length > 0) msg += rows.map(r => `• [ID:${r.id}] $${formatCurrency(r.amount)} - ${r.description} (${r.category})`).join('\n') + `\n\n💰 *Total: $${formatCurrency(total)}*`;
    else msg += "Sin gastos.";
    ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  } else if (type === 'edit_cat') {
    const [catId, expenseId] = payload.split('_');
    await pool.query('UPDATE expenses SET category_id = $1 WHERE id = $2', [catId, expenseId]);
    ctx.editMessageText(`✅ Gasto [ID:${expenseId}] movido.`);
  } else if (type === 'rename_start') {
    userStates[ctx.chat!.id] = { action: 'renaming', catId: parseInt(payload) };
    ctx.editMessageText(`📝 Escribí el **nuevo nombre** para la categoría:`);
  } else if (type === 'del_cat') {
    try {
      await pool.query('DELETE FROM categories WHERE id = $1', [payload]);
      ctx.editMessageText('✅ Categoría eliminada.');
    } catch { ctx.editMessageText('❌ Error: La categoría tiene gastos.'); }
  }
});

// --- SERVIDOR DE SALUD (RENDER) ---
const server = http.createServer((req, res) => { res.writeHead(200); res.end('Bot activo'); });
server.listen(process.env.PORT || 3000);

bot.launch().then(() => console.log('🚀 Bot iniciado.')).catch((err) => console.error("❌ Error:", err));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));