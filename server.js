/**
 * MeetAlarm Global Server - Render 배포용
 * - PostgreSQL 기반 (Render 무료 DB 사용)
 * - 회사별 데이터 완전 격리 (Multi-tenant)
 */

const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// Render에서 자동으로 DATABASE_URL 환경변수를 제공합니다
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// DB 테이블 초기화
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      name TEXT,
      company_id TEXT,
      pw TEXT NOT NULL,
      dept_id TEXT,
      PRIMARY KEY (name, company_id)
    );

    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      title TEXT NOT NULL,
      datetime TEXT NOT NULL,
      location TEXT,
      organizer TEXT,
      attendees TEXT,
      completed INTEGER DEFAULT 0,
      alarm1 INTEGER DEFAULT 60,
      agenda TEXT,
      zoom_link TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      author TEXT NOT NULL,
      dept_id TEXT,
      visibility TEXT DEFAULT 'team'
    );

    CREATE TABLE IF NOT EXISTS recurring_templates (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_overrides (
      key TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_completed (
      id TEXT,
      company_id TEXT,
      PRIMARY KEY (id, company_id)
    );
  `);
  console.log('DB 초기화 완료');
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-company-id');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const url = req.url.split('?')[0];
  const companyId = req.headers['x-company-id'];

  const send = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const getBody = () => new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { resolve({}); } });
  });

  try {
    // ── 핑 테스트 ──────────────────────────────
    if (url === '/api/ping') return send({ ok: true });

    // ── 회사 등록 / 초대코드 확인 ──────────────
    if (req.method === 'POST' && url === '/api/company/register') {
      const { companyName } = await getBody();
      const id = 'co_' + Date.now();
      const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await pool.query('INSERT INTO companies(id,name,invite_code) VALUES($1,$2,$3)', [id, companyName, inviteCode]);
      return send({ companyId: id, inviteCode });
    }

    if (req.method === 'GET' && url.startsWith('/api/company/check/')) {
      const code = url.split('/').pop();
      const { rows } = await pool.query('SELECT id,name FROM companies WHERE invite_code=$1', [code]);
      return rows.length ? send(rows[0]) : send({ error: '유효하지 않은 초대코드입니다' }, 404);
    }

    // ── 회원가입 / 로그인 ───────────────────────
    if (req.method === 'POST' && url === '/api/register') {
      const { name, pw, deptId, companyId: cId } = await getBody();
      const { rows } = await pool.query('SELECT name FROM users WHERE name=$1 AND company_id=$2', [name, cId]);
      if (rows.length) return send({ error: '이미 사용 중인 이름입니다' }, 400);
      await pool.query('INSERT INTO users(name,company_id,pw,dept_id) VALUES($1,$2,$3,$4)', [name, cId, pw, deptId || null]);
      broadcast(cId, { event: 'users_updated' });
      return send({ ok: true });
    }

    if (req.method === 'POST' && url === '/api/login') {
      const { name, pw, companyId: cId } = await getBody();
      const { rows } = await pool.query('SELECT * FROM users WHERE name=$1 AND company_id=$2', [name, cId]);
      if (!rows.length || rows[0].pw !== pw) return send({ error: '이름 또는 비밀번호가 틀렸습니다' }, 401);
      return send({ ok: true, deptId: rows[0].dept_id });
    }

    if (req.method === 'GET' && url === '/api/users') {
      const { rows } = await pool.query('SELECT name,dept_id FROM users WHERE company_id=$1', [companyId]);
      return send(rows);
    }

    // ── 이하 모든 API는 companyId 필수 ──────────
    if (!companyId) return send({ error: '접근 권한 없음' }, 403);

    // ── 미팅 ────────────────────────────────────
    if (req.method === 'GET' && url === '/api/meetings') {
      const { rows } = await pool.query('SELECT * FROM meetings WHERE company_id=$1', [companyId]);
      return send(rows.map(r => ({ ...r, attendees: JSON.parse(r.attendees || '[]') })));
    }

    if (req.method === 'POST' && url === '/api/meetings') {
      const b = await getBody();
      const id = 'meet_' + Date.now();
      await pool.query(
        `INSERT INTO meetings(id,company_id,title,datetime,location,organizer,attendees,alarm1,agenda,zoom_link)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, companyId, b.title, b.datetime, b.location, b.organizer, JSON.stringify(b.attendees || []), b.alarm1, b.agenda, b.zoomLink]
      );
      broadcast(companyId, { event: 'meeting_created', data: { id } });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/meetings/') && !url.includes('/alarm') && !url.includes('/complete') && !url.includes('/leave') && !url.includes('/hide')) {
      const id = url.split('/').pop();
      await pool.query('DELETE FROM meetings WHERE id=$1 AND company_id=$2', [id, companyId]);
      broadcast(companyId, { event: 'meeting_deleted', data: { id } });
      return send({ ok: true });
    }

    if (req.method === 'PUT' && url.includes('/complete')) {
      const id = url.split('/')[3];
      await pool.query('UPDATE meetings SET completed=1 WHERE id=$1 AND company_id=$2', [id, companyId]);
      broadcast(companyId, { event: 'meeting_updated', data: { id } });
      return send({ ok: true });
    }

    if (req.method === 'PUT' && url.includes('/leave')) {
      const id = url.split('/')[3];
      const { userName } = await getBody();
      const { rows } = await pool.query('SELECT attendees FROM meetings WHERE id=$1', [id]);
      if (rows.length) {
        let atts = JSON.parse(rows[0].attendees || '[]').filter(a => (a.user_name || a) !== userName);
        await pool.query('UPDATE meetings SET attendees=$1 WHERE id=$2', [JSON.stringify(atts), id]);
        broadcast(companyId, { event: 'meeting_updated', data: { id } });
      }
      return send({ ok: true });
    }

    if (req.method === 'PUT' && url.includes('/alarm')) {
      const id = url.split('/')[3];
      const { userName, type } = await getBody();
      const { rows } = await pool.query('SELECT attendees FROM meetings WHERE id=$1', [id]);
      if (rows.length) {
        let atts = JSON.parse(rows[0].attendees || '[]').map(a => {
          if ((a.user_name || a) === userName) {
            const obj = typeof a === 'string' ? { user_name: a } : { ...a };
            if (type === 'first') obj.alarm_first = 1;
            if (type === 'five') { obj.alarm_first = 1; obj.alarm_five = 1; }
            if (type === 'start') { obj.alarm_first = 1; obj.alarm_five = 1; obj.alarm_start = 1; }
            return obj;
          }
          return a;
        });
        await pool.query('UPDATE meetings SET attendees=$1 WHERE id=$2', [JSON.stringify(atts), id]);
      }
      return send({ ok: true });
    }

    if (req.method === 'PUT' && url.includes('/hide')) {
      return send({ ok: true }); // hide는 클라이언트 localStorage에서 처리
    }
    if (req.method === 'PUT' && url.includes('/unhide')) {
      return send({ ok: true });
    }

    // ── 부서 ────────────────────────────────────
    if (req.method === 'GET' && url === '/api/departments') {
      const { rows } = await pool.query('SELECT id,name,color FROM departments WHERE company_id=$1', [companyId]);
      return send(rows);
    }

    if (req.method === 'POST' && url === '/api/departments') {
      const { id: dId, name, color } = await getBody();
      const newId = dId || ('dept_' + Date.now());
      await pool.query('INSERT INTO departments(id,company_id,name,color) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=$3,color=$4', [newId, companyId, name, color]);
      const { rows } = await pool.query('SELECT id,name,color FROM departments WHERE company_id=$1', [companyId]);
      broadcast(companyId, { event: 'dept_updated', data: rows });
      return send({ ok: true });
    }

    if (req.method === 'PUT' && url.startsWith('/api/departments/')) {
      const id = url.split('/').pop();
      const { name, color } = await getBody();
      await pool.query('UPDATE departments SET name=$1,color=$2 WHERE id=$3 AND company_id=$4', [name, color, id, companyId]);
      const { rows } = await pool.query('SELECT id,name,color FROM departments WHERE company_id=$1', [companyId]);
      broadcast(companyId, { event: 'dept_updated', data: rows });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/departments/')) {
      const id = url.split('/').pop();
      await pool.query('DELETE FROM departments WHERE id=$1 AND company_id=$2', [id, companyId]);
      const { rows } = await pool.query('SELECT id,name,color FROM departments WHERE company_id=$1', [companyId]);
      broadcast(companyId, { event: 'dept_updated', data: rows });
      return send({ ok: true });
    }

    // ── 구성원 관리 ─────────────────────────────
    if (req.method === 'PUT' && url.startsWith('/api/users/')) {
      const name = decodeURIComponent(url.split('/').pop());
      const { deptId, pw } = await getBody();
      if (pw) await pool.query('UPDATE users SET dept_id=$1,pw=$2 WHERE name=$3 AND company_id=$4', [deptId, pw, name, companyId]);
      else await pool.query('UPDATE users SET dept_id=$1 WHERE name=$2 AND company_id=$3', [deptId, name, companyId]);
      const { rows } = await pool.query('SELECT name,dept_id FROM users WHERE company_id=$1', [companyId]);
      broadcast(companyId, { event: 'users_updated', data: rows });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/users/')) {
      const name = decodeURIComponent(url.split('/').pop());
      await pool.query('DELETE FROM users WHERE name=$1 AND company_id=$2', [name, companyId]);
      const { rows } = await pool.query('SELECT name,dept_id FROM users WHERE company_id=$1', [companyId]);
      broadcast(companyId, { event: 'users_updated', data: rows });
      return send({ ok: true });
    }

    // ── 일정 (schedules) ────────────────────────
    if (req.method === 'GET' && url === '/api/schedules') {
      const { rows } = await pool.query('SELECT * FROM schedules WHERE company_id=$1', [companyId]);
      return send(rows);
    }

    if (req.method === 'POST' && url === '/api/schedules') {
      const b = await getBody();
      const id = 'sch_' + Date.now();
      await pool.query(
        'INSERT INTO schedules(id,company_id,date,content,author,dept_id,visibility) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, companyId, b.date, b.content, b.author, b.deptId || null, b.visibility || 'team']
      );
      broadcast(companyId, { event: 'schedules_updated' });
      return send({ ok: true, id });
    }

    if (req.method === 'PUT' && url.startsWith('/api/schedules/') && !url.includes('/comments')) {
      const id = url.split('/').pop();
      const b = await getBody();
      await pool.query('UPDATE schedules SET content=$1,visibility=$2,dept_id=$3 WHERE id=$4 AND company_id=$5', [b.content, b.visibility, b.deptId || null, id, companyId]);
      broadcast(companyId, { event: 'schedules_updated' });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/schedules/')) {
      const id = url.split('/').pop();
      await pool.query('DELETE FROM schedules WHERE id=$1 AND company_id=$2', [id, companyId]);
      broadcast(companyId, { event: 'schedules_updated' });
      return send({ ok: true });
    }

    // ── 정기 미팅 ───────────────────────────────
    if (req.method === 'GET' && url === '/api/recurring') {
      const { rows: tRows } = await pool.query('SELECT data FROM recurring_templates WHERE company_id=$1', [companyId]);
      const { rows: oRows } = await pool.query('SELECT key,data FROM recurring_overrides WHERE company_id=$1', [companyId]);
      const { rows: cRows } = await pool.query('SELECT id FROM recurring_completed WHERE company_id=$1', [companyId]);
      const templates = tRows.map(r => JSON.parse(r.data));
      const overrides = {};
      oRows.forEach(r => { overrides[r.key] = JSON.parse(r.data); });
      const completed = cRows.map(r => r.id);
      return send({ templates, overrides, completed });
    }

    if (req.method === 'POST' && url === '/api/recurring/templates') {
      const b = await getBody();
      await pool.query(
        'INSERT INTO recurring_templates(id,company_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=$3',
        [b.id, companyId, JSON.stringify(b)]
      );
      broadcast(companyId, { event: 'recurring_updated' });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/recurring/templates/')) {
      const id = url.split('/').pop();
      await pool.query('DELETE FROM recurring_templates WHERE id=$1 AND company_id=$2', [id, companyId]);
      broadcast(companyId, { event: 'recurring_updated' });
      return send({ ok: true });
    }

    if (req.method === 'POST' && url.startsWith('/api/recurring/overrides/')) {
      const key = url.split('/api/recurring/overrides/')[1];
      const b = await getBody();
      await pool.query(
        'INSERT INTO recurring_overrides(key,company_id,data) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET data=$3',
        [key, companyId, JSON.stringify(b)]
      );
      broadcast(companyId, { event: 'recurring_updated' });
      return send({ ok: true });
    }

    send({ error: 'Not found' }, 404);

  } catch (e) {
    console.error('Server Error:', e);
    send({ error: 'Internal Server Error' }, 500);
  }
});

// ── 웹소켓 ─────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('message', m => {
    try {
      const data = JSON.parse(m);
      if (data.event === 'auth') {
        ws.companyId = data.companyId;
        ws.userName = data.name;
      }
    } catch(e) {}
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast(cId, obj) {
  const msg = JSON.stringify(obj);
  clients.forEach(ws => {
    if (ws.companyId === cId && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── 서버 시작 ───────────────────────────────────
initDB().then(() => {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MeetAlarm Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});
