import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import pg from 'pg';
import { formatCurrency, getPeriodFilter } from './utils.js';
import http from 'http';
const { Pool } = pg;

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

// commands
bot.command('categoria', async (ctx) => {
  const name = ctx.payload;
  if (!name) return ctx.reply('Uso: /categoria [nombre]');
  await pool.query('INSERT INTO categories (name) VALUES ($1)', [name]);
  ctx.reply(`✅ Categoría "${name}" agregada.`);
});

bot.command('editar', async (ctx) => {
  const id = ctx.payload;
  if (!id) return ctx.reply('Uso: /editar [ID_GASTO]');
  
  // check if the expense exists
  const { rows } = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  if (rows.length === 0) return ctx.reply('❌ Gasto no encontrado.');

  // show category buttons to reasign
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

// text for /ayuda command
bot.command('ayuda', (ctx) => {
  const mensajeAyuda = `
🤖 *Guía de uso del Bot de Finanzas*

*1. Registrar un gasto:*
Simplemente envía el monto y la descripción (o viceversa).
Ejemplos:
• \`20000 supermercado\`
• \`supermercado 20000\`
Después de escribir el gasto y enviarselo al bot, este te va a preguntar en que categoria queres colocar el gasto, selecciona la que quieras y listo.

*2. Comandos disponibles:*
• /categoria [nombre] - Crea una nueva categoría.
• /resumen - Abre el menú de reportes y totales.
• /editar [ID] - Cambia la categoría de un gasto existente.
• /eliminar [ID] - Borra un gasto definitivamente.
• /ayuda - Muestra este mensaje.

*Tip:* Los IDs de tus gastos aparecen en el reporte detallado al seleccionar una categoría específica.
`;
  ctx.replyWithMarkdown(mensajeAyuda);
});

// send welcome message with some instructions
bot.start((ctx) => {
  ctx.reply("¡Hola! Soy tu bot de finanzas. Para empezar, crea tus categorías con /categoria [nombre]. Usa /ayuda si tienes dudas.");
});


// regex to detect any format: "20000 something" or "something 20000"
bot.hears(/^(\d+(?:\.\d+)?)\s+(.+)$|^(.+)\s+(\d+(?:\.\d+)?)$/, async (ctx) => {
  const match = ctx.match;
  // if match[1] exists, the number is at the beginning, if not, it's in match[4]
  const amount = parseFloat(match[1] || match[4]);
  const description = (match[2] || match[3]).trim();

  const res = await pool.query(
    'INSERT INTO temp_pending_expenses(amount, description) VALUES($1, $2) RETURNING id',
    [amount, description]
  );
  
  const { rows } = await pool.query('SELECT * FROM categories');
  if (rows.length === 0) return ctx.reply('❌ No tienes categorías. Usa /categoria [nombre] para crear una.');
  
  const buttons = rows.map(c => [Markup.button.callback(c.name, `cat_sel_${c.id}_${res.rows[0].id}`)]);
  ctx.reply(`Gasto: $${amount} (${description}). ¿A qué categoría pertenece?`, Markup.inlineKeyboard(buttons));
});

// cb buttons
bot.action(/^(per|cat_sel|cat_fil|edit_cat)_(.+)$/, async (ctx) => {
  // answer callback query
  await ctx.answerCbQuery(); 
  
  const type = ctx.match[1];
  const payload = ctx.match[2];

  if (type === 'per') {
    const { rows } = await pool.query('SELECT name, id FROM categories');
    const buttons = rows.map(c => [Markup.button.callback(`Solo ${c.name}`, `cat_fil_${payload}_${c.name}`)]);
    buttons.push([Markup.button.callback('Todas las categorías', `cat_fil_${payload}_todas`)]);
    ctx.editMessageText('🏷️ Elige categoría:', Markup.inlineKeyboard(buttons));
  } 
  else if (type === 'cat_sel') {
    const [categoryId, tempId] = payload.split('_');
    const temp = await pool.query('DELETE FROM temp_pending_expenses WHERE id = $1 RETURNING *', [tempId]);
    if (temp.rows.length > 0) {
      await pool.query('INSERT INTO expenses(amount, description, category_id) VALUES($1, $2, $3)', 
        [temp.rows[0].amount, temp.rows[0].description, categoryId]);
      ctx.editMessageText('✅ Gasto registrado.');
    }
  }
  else if (type === 'cat_fil') {
    const [period, category] = payload.split('_');
    const dateFilter = getPeriodFilter(period); // utils from utils.ts
    
    let query = `SELECT e.id, e.amount, e.description, c.name as category 
                 FROM expenses e 
                 JOIN categories c ON e.category_id = c.id 
                 WHERE ${dateFilter}`;
    
    if (category !== 'todas') query += ` AND c.name = '${category}'`;
    query += ` ORDER BY e.created_at DESC LIMIT 10`;

    const { rows } = await pool.query(query);
    const total = rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);
    
    let msg = `📊 *Resultado (${period} / ${category}):*\n\n`;
    
    if (rows.length > 0) {
      msg += rows.map(r => `• [ID:${r.id}] $${formatCurrency(r.amount)} - ${r.description} (${r.category})`).join('\n');
      msg += `\n\n💰 *Total: $${formatCurrency(total)}*`;
    } else {
      msg += "Sin gastos en este filtro.";
    }
    
    ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  }
  else if (type === 'edit_cat') {
    // payload here is "catId_expenseId"
    const [catId, expenseId] = payload.split('_');
    
    // execute the change
    await pool.query('UPDATE expenses SET category_id = $1 WHERE id = $2', [catId, expenseId]);
    
    // confirm to user
    ctx.editMessageText(`✅ Gasto [ID:${expenseId}] movido exitosamente.`);
  }
});

// we can add this if the bot fall asleep in render, using something like uptimereboot to ping the server every x time so it will never fall asleep
// const server = http.createServer((req, res) => {
//   res.writeHead(200);
//   res.end('Bot activo');
// });
// server.listen(process.env.PORT || 3000);

// launch bot
bot.launch().then(() => {
  console.log('🚀 Bot iniciado y listo para recibir mensajes.');
}).catch((err) => {
  console.error("❌ Error al lanzar el bot:", err);
});

// stop bot
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));