import { performance } from 'node:perf_hooks';
import pg from 'pg';

// The URL has already been checked by authorize(). Parse it ourselves so pg's
// connection-string SSL options cannot replace explicit certificate verification.
/**
 * @param {string} connection
 * @param {{attachPool?: (pool: import('pg').Pool) => void, max?: number}} [options]
 */
export const createQualificationQuery = (connection, { attachPool, max = 20 } = {}) => {
  const url = new URL(connection);
  const options = {
    host: url.hostname,
    port: Number(url.port),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true },
    max,
    connectionTimeoutMillis: 1_500,
    idleTimeoutMillis: 5_000,
  };
  const pool = new pg.Pool(options);
  // Idle socket errors carry no sample context and may contain endpoint details.
  pool.on('error', () => {});
  attachPool?.(pool);
  const query = async (text, values, { fresh = false } = {}) => {
    const selected = fresh ? new pg.Pool({ ...options, max: 1 }) : pool;
    const start = performance.now();
    try {
      const client = await selected.connect();
      const checkoutMs = performance.now() - start;
      try {
        const { rows } = await client.query(text, values);
        client.release();
        return { rows, checkoutMs };
      } catch (error) {
        client.release(error);
        throw error;
      }
    } finally {
      if (fresh) await selected.end();
    }
  };
  query.close = () => pool.end();
  return query;
};
