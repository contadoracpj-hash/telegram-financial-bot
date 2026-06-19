import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.connect()
  .then(() => console.log('✅ Conectado exitosamente a PostgreSQL'))
  .catch(err => console.error('❌ Error conectando a la DB:', err.message));