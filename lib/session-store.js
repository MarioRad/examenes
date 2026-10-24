'use strict';

/**
 * Store de express-session sobre libSQL/Turso.
 * En Vercel cada request puede caer en otra instancia: la sesion no puede vivir
 * en memoria del proceso, tiene que persistir en la base.
 */

const session = require('express-session');
const { all, run } = require('./db');

const TTL_DEFAULT_MS = 24 * 60 * 60 * 1000;

class LibsqlStore extends session.Store {
  constructor(opciones = {}) {
    super();
    this.ttl = opciones.ttl || TTL_DEFAULT_MS;
  }

  async get(sid, cb) {
    try {
      const fila = (await all('SELECT sess, expires FROM Sesiones WHERE sid = ?', [sid]))[0];
      if (!fila) return cb(null, null);
      if (Number(fila.expires) < Date.now()) {
        await run('DELETE FROM Sesiones WHERE sid = ?', [sid]);
        return cb(null, null);
      }
      return cb(null, JSON.parse(fila.sess));
    } catch (err) {
      return cb(err);
    }
  }

  async set(sid, sess, cb) {
    try {
      const expires = Date.now() + this.ttl;
      await run(
        `INSERT INTO Sesiones (sid, sess, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
        [sid, JSON.stringify(sess), expires]
      );
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  async destroy(sid, cb) {
    try {
      await run('DELETE FROM Sesiones WHERE sid = ?', [sid]);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  async touch(sid, sess, cb) {
    try {
      await run('UPDATE Sesiones SET expires = ? WHERE sid = ?', [Date.now() + this.ttl, sid]);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

module.exports = { LibsqlStore };
