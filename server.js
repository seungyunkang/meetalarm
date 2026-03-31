/**
 * MeetAlarm Global Server - Render 배포용
 * - PostgreSQL 기반 (Render 무료 DB 사용)
 * - 회사별 데이터 완전 격리 (Multi-tenant)
 * - [보안 강화] bcrypt 비밀번호 암호화 및 이메일 초기화 적용
 */

const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;

// Render에서 자동으로 DATABASE_URL 환경변수를 제공합니다
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 이메일 발송기 설정 (실제 운영 시 환경변수로 관리하는 것을 권장함)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'your-email@gmail.com', // 운영자 구글 이메일
    pass: process.env.EMAIL_PASS || 'your-app-password'     // 구글 앱 비밀번호
  }
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
      email TEXT, -- 비밀번호 찾기용 이메일
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
      archived INTEGER DEFAULT 0,
      alarm1 INTEGER DEFAULT 60,
      agenda TEXT,
      zoom_link TEXT,
      minutes_list TEXT
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

    CREATE TABLE IF NOT EXISTS schedule_comments (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recurring_minutes (
      id TEXT PRIMARY KEY,
      rec_instance_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('DB 초기화 완료');
  
  // 기존 테이블 하위 호환성을 위한 ALTER 처리
  try { await pool.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS archived INTEGER DEFAULT 0'); } catch(e) {}
  try { await pool.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS minutes_list TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()'); } catch(e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_ids TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS today_done_ids TEXT'); } catch(e) {}
  try { await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT'); } catch(e) {}
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

  // 유저 목록 불러오기 (설정값 변환 헬퍼 함수)
  const fetchUsers = async (cId) => {
    const { rows } = await pool.query('SELECT name,dept_id,email,hidden_ids,today_done_ids FROM users WHERE company_id=$1 ORDER BY created_at ASC NULLS FIRST, name ASC', [cId]);
    return rows.map(r => ({
      ...r, 
      hiddenIds: r.hidden_ids ? JSON.parse(r.hidden_ids) : [],
      todayDoneIds: r.today_done_ids ? JSON.parse(r.today_done_ids) : []
    }));
  };

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

    if (req.method === 'GET' && url === '/api/company/invite-code') {
      const { rows } = await pool.query('SELECT invite_code FROM companies WHERE id=$1', [companyId]);
      return rows.length ? send({ inviteCode: rows[0].invite_code }) : send({ error: 'Not found' }, 404);
    }

    if (req.method === 'POST' && url === '/api/company/regen-invite') {
      const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await pool.query('UPDATE companies SET invite_code=$1 WHERE id=$2', [newCode, companyId]);
      return send({ inviteCode: newCode });
    }

    // ── 회원가입 / 로그인 ───────────────────────
    if (req.method === 'POST' && url === '/api/register') {
      const { name, email, pw, deptId, companyId: cId } = await getBody();
      const { rows } = await pool.query('SELECT name FROM users WHERE name=$1 AND company_id=$2', [name, cId]);
      if (rows.length) return send({ error: '이미 사용 중인 이름입니다' }, 400);
      
      // 단방향 암호화 적용 (Salt Rounds: 10)
      const hashedPw = await bcrypt.hash(pw, 10);
      
      await pool.query('INSERT INTO users(name,company_id,pw,dept_id,email) VALUES($1,$2,$3,$4,$5)', [name, cId, hashedPw, deptId || null, email]);
      const updatedUsers = await fetchUsers(cId);
      broadcast(cId, { event: 'users_updated', data: updatedUsers });
      return send({ ok: true });
    }

    if (req.method === 'POST' && url === '/api/login') {
      const { name, pw, companyId: cId } = await getBody();
      const { rows } = await pool.query('SELECT * FROM users WHERE name=$1 AND company_id=$2', [name, cId]);
      
      if (!rows.length) return send({ error: '이름 또는 비밀번호가 틀렸습니다' }, 401);
      
      // 저장된 해시값과 입력받은 비밀번호 비교
      const isMatch = await bcrypt.compare(pw, rows[0].pw);
      if (!isMatch) return send({ error: '이름 또는 비밀번호가 틀렸습니다' }, 401);
      
      return send({ ok: true, deptId: rows[0].dept_id });
    }

    // ── 비밀번호 초기화 (이메일 발송) ───────────
    if (req.method === 'POST' && url === '/api/reset-password') {
      const { name, email, companyId: cId } = await getBody();
      
      const { rows } = await pool.query('SELECT * FROM users WHERE name=$1 AND company_id=$2 AND email=$3', [name, cId, email]);
      if (rows.length === 0) return send({ error: '일치하는 사용자 정보가 없습니다.' }, 404);

      // 랜덤 임시 비밀번호 8자리 생성 및 암호화
      const tempPw = Math.random().toString(36).slice(-8);
      const hashedPw = await bcrypt.hash(tempPw, 10);
      
      // DB 업데이트
      await pool.query('UPDATE users SET pw=$1 WHERE name=$2 AND company_id=$3', [hashedPw, name, cId]);

      // 메일 발송 설정
      const mailOptions = {
        from: process.env.EMAIL_USER || 'your-email@gmail.com',
        to: email,
        subject: '[MeetAlarm] 임시 비밀번호 발급 안내',
        text: `안녕하세요 ${name}님,\n\n요청하신 임시 비밀번호는 [ ${tempPw} ] 입니다.\n로그인 후 반드시 설정에서 비밀번호를 변경해 주세요.`
      };

      try {
        await transporter.sendMail(mailOptions);
        return send({ ok: true, message: '이메일로 임시 비밀번호가 발송되었습니다.' });
      } catch (error) {
        console.error('Email send error:', error);
        return send({ error: '이메일 발송에 실패했습니다. 서버 설정을 확인하세요.' }, 500);
      }
    }

    // 그룹 동기화 (bcrypt 적용 시 평문 쿼리가 불가하므로 로직 변경)
    if (req.method === 'POST' && url === '/api/sync-groups') {
      const { name, pw } = await getBody();
      if (!name || !pw) return send({ error: '정보 누락' }, 400);
      
      const { rows } = await pool.query(`
        SELECT u.company_id, c.name as company_name, u.name as user_name, u.pw
        FROM users u JOIN companies c ON u.company_id = c.id
        WHERE u.name = $1
      `, [name]);
      
      const matchedRows = [];
      for (let row of rows) {
        if (await bcrypt.compare(pw, row.pw)) {
          matchedRows.push({
            company_id: row.company_id,
            company_name: row.company_name,
            user_name: row.user_name,
            pw: pw // 프론트엔드의 다중 계정 유지를 위해 평문 리턴 (HTTPS 필수)
          });
        }
      }
      return send(matchedRows);
    }

    if (req.method === 'GET' && url === '/api/users') {
      const updatedUsers = await fetchUsers(companyId);
      return send(updatedUsers);
    }

    // ── 이하 모든 API는 companyId 필수 ──────────
    if (!companyId) return send({ error: '접근 권한 없음' }, 403);

    // 사용자 개인 설정(숨긴 미팅, 취소선) 저장
    if (req.method === 'PUT' && url.includes('/prefs') && url.startsWith('/api/users/')) {
      const name = decodeURIComponent(url.split('/')[3]);
      const { hiddenIds, todayDoneIds } = await getBody();
      
      await pool.query(
        'UPDATE users SET hidden_ids=$1, today_done_ids=$2 WHERE name=$3 AND company_id=$4',
        [JSON.stringify(hiddenIds || []), JSON.stringify(todayDoneIds || []), name, companyId]
      );
      
      const updatedUsers = await fetchUsers(companyId);
      broadcast(companyId, { event: 'users_updated', data: updatedUsers });
      return send({ ok: true });
    }

    // 구성원 관리
    if (req.method === 'PUT' && url.startsWith('/api/users/') && !url.includes('/prefs')) {
      const name = decodeURIComponent(url.split('/').pop());
      const { deptId, pw } = await getBody();
      if (pw) {
        const hashedPw = await bcrypt.hash(pw, 10);
        await pool.query('UPDATE users SET dept_id=$1,pw=$2 WHERE name=$3 AND company_id=$4', [deptId, hashedPw, name, companyId]);
      } else {
        await pool.query('UPDATE users SET dept_id=$1 WHERE name=$2 AND company_id=$3', [deptId, name, companyId]);
      }
      const updatedUsers = await fetchUsers(companyId);
      broadcast(companyId, { event: 'users_updated', data: updatedUsers });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.startsWith('/api/users/')) {
      const name = decodeURIComponent(url.split('/').pop());
      await pool.query('DELETE FROM users WHERE name=$1 AND company_id=$2', [name, companyId]);
      const updatedUsers = await fetchUsers(companyId);
      broadcast(companyId, { event: 'users_updated', data: updatedUsers });
      return send({ ok: true });
    }

    // ── 미팅 ────────────────────────────────────
    if (req.method === 'POST' && url === '/api/meetings/save-and-archive') {
      const b = await getBody();
      const id = 'meet_' + Date.now();
      await pool.query(
        `INSERT INTO meetings(id,company_id,title,datetime,location,organizer,attendees,alarm1,agenda,zoom_link,minutes_list,archived)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
        [id, companyId, b.title, b.datetime, b.location, b.organizer,
         JSON.stringify(b.attendees || []), b.alarm1, b.agenda, b.zoomLink || '',
         JSON.stringify(b.minutes_list || [])]
      );
      broadcast(companyId, { event: 'meeting_ended', data: { ...b, id } });
      return send({ ok: true, id });
    }

    if (req.method === 'GET' && url === '/api/meetings') {
      const { rows } = await pool.query('SELECT * FROM meetings WHERE company_id=$1 AND (archived IS NULL OR archived=0)', [companyId]);
      return send(rows.map(r => ({ 
        ...r, 
        attendees: JSON.parse(r.attendees || '[]'),
        minutes_list: r.minutes_list ? JSON.parse(r.minutes_list) : []
      })));
    }

    if (req.method === 'GET' && url === '/api/meetings/archived') {
      const { rows } = await pool.query('SELECT * FROM meetings WHERE company_id=$1 AND archived=1 ORDER BY datetime DESC', [companyId]);
      return send(rows.map(r => ({ 
        ...r, 
        attendees: JSON.parse(r.attendees || '[]'),
        minutes_list: r.minutes_list ? JSON.parse(r.minutes_list) : []
      })));
    }

    if (req.method === 'PUT' && url.includes('/minutes_list')) {
      const id = url.split('/')[3];
      const { minutes_list } = await getBody();
      await pool.query('UPDATE meetings SET minutes_list=$1 WHERE id=$2 AND company_id=$3', [JSON.stringify(minutes_list), id, companyId]);
      broadcast(companyId, { event: 'meeting_updated', data: { id } });
      return send({ ok: true });
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

    if (req.method === 'DELETE' && url.startsWith('/api/meetings/') && !url.includes('/alarm') && !url.includes('/complete') && !url.includes('/leave') && !url.includes('/hide') && !url.includes('/archive')) {
      const id = url.split('/').pop();
      await pool.query('DELETE FROM meetings WHERE id=$1 AND company_id=$2', [id, companyId]);
      broadcast(companyId, { event: 'meeting_deleted', data: { id } });
      return send({ ok: true });
    }

    // ── 아카이브 ─────────────────────────────────
    if (req.method === 'PUT' && url.includes('/archive')) {
      const id = url.split('/')[3];
      const { rows } = await pool.query('SELECT * FROM meetings WHERE id=$1 AND company_id=$2', [id, companyId]);
      await pool.query('UPDATE meetings SET archived=1 WHERE id=$1 AND company_id=$2', [id, companyId]);
      const meetingData = rows.length ? { ...rows[0], attendees: JSON.parse(rows[0].attendees || '[]') } : { id };
      broadcast(companyId, { event: 'meeting_ended', data: meetingData });
      return send({ ok: true });
    }

    if (req.method === 'PUT' && url.includes('/complete')) {
      const id = url.split('/')[3];
      const { rows } = await pool.query('SELECT * FROM meetings WHERE id=$1 AND company_id=$2', [id, companyId]);
      await pool.query('UPDATE meetings SET completed=1 WHERE id=$1 AND company_id=$2', [id, companyId]);
      const meetingData = rows.length ? { ...rows[0], attendees: JSON.parse(rows[0].attendees || '[]') } : { id };
      broadcast(companyId, { event: 'meeting_ended', data: meetingData });
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

    if (req.method === 'PUT' && url.includes('/hide')) { return send({ ok: true }); }
    if (req.method === 'PUT' && url.includes('/unhide')) { return send({ ok: true }); }

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

    // ── 일정 (schedules) ────────────────────────
    if (req.method === 'GET' && url === '/api/schedules') {
      const { rows } = await pool.query('SELECT * FROM schedules WHERE company_id=$1', [companyId]);
      const { rows: cRows } = await pool.query('SELECT * FROM schedule_comments WHERE company_id=$1 ORDER BY created_at ASC', [companyId]);
      const result = rows.map(s => ({
        ...s,
        comments: cRows.filter(c => c.schedule_id === s.id)
      }));
      return send(result);
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
      const { rows: mRows } = await pool.query('SELECT DISTINCT rec_instance_id FROM recurring_minutes WHERE company_id=$1', [companyId]);
      
      const templates = tRows.map(r => JSON.parse(r.data));
      const overrides = {};
      oRows.forEach(r => { overrides[r.key] = JSON.parse(r.data); });
      const completed = cRows.map(r => r.id);
      const withMinutes = mRows.map(r => r.rec_instance_id);

      return send({ templates, overrides, completed, withMinutes });
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

    if (req.method === 'POST' && url.startsWith('/api/recurring/completed')) {
      const { id } = await getBody();
      await pool.query(
        'INSERT INTO recurring_completed(id,company_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [id, companyId]
      );
      broadcast(companyId, { event: 'recurring_updated' });
      return send({ ok: true });
    }

    // ── 일정 댓글 ───────────────────────────────
    if (req.method === 'GET' && url.includes('/comments')) {
      const schId = url.split('/')[3];
      const { rows } = await pool.query(
        'SELECT * FROM schedule_comments WHERE schedule_id=$1 AND company_id=$2 ORDER BY created_at ASC',
        [schId, companyId]
      );
      return send(rows);
    }

    if (req.method === 'POST' && url.includes('/comments')) {
      const schId = url.split('/')[3];
      const { author, content } = await getBody();
      const id = 'cmt_' + Date.now();
      await pool.query(
        'INSERT INTO schedule_comments(id,schedule_id,company_id,author,content,created_at) VALUES($1,$2,$3,$4,$5,NOW())',
        [id, schId, companyId, author, content]
      );
      broadcast(companyId, { event: 'schedules_updated' });
      return send({ ok: true });
    }

    if (req.method === 'DELETE' && url.includes('/comments/')) {
      const parts = url.split('/');
      const cmtId = parts.pop();
      await pool.query('DELETE FROM schedule_comments WHERE id=$1 AND company_id=$2', [cmtId, companyId]);
      broadcast(companyId, { event: 'schedules_updated' });
      return send({ ok: true });
    }

    // 정기 미팅 회의록 조회
    if (req.method === 'GET' && url.startsWith('/api/recurring/minutes/')) {
      const instanceId = url.split('/api/recurring/minutes/')[1];
      const { rows } = await pool.query(
        'SELECT * FROM recurring_minutes WHERE rec_instance_id=$1 AND company_id=$2 ORDER BY updated_at ASC',
        [instanceId, companyId]
      );
      return send(rows);
    }

    // 정기 미팅 회의록 저장
    if (req.method === 'POST' && url.startsWith('/api/recurring/minutes/')) {
      const instanceId = url.split('/api/recurring/minutes/')[1];
      const { author, content, editId } = await getBody();
      if(editId) {
        await pool.query('UPDATE recurring_minutes SET content=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3', [content, editId, companyId]);
      } else {
        const id = 'rmin_' + Date.now();
        await pool.query(
          'INSERT INTO recurring_minutes(id,rec_instance_id,company_id,author,content) VALUES($1,$2,$3,$4,$5)',
          [id, instanceId, companyId, author, content]
        );
      }
      broadcast(companyId, { event: 'recurring_minutes_updated', data: { instanceId } });
      return send({ ok: true });
    }

    // 정기 미팅 회의록 삭제
    if (req.method === 'DELETE' && url.startsWith('/api/recurring/minutes/')) {
      const parts = url.split('/');
      const minId = parts.pop();
      await pool.query('DELETE FROM recurring_minutes WHERE id=$1 AND company_id=$2', [minId, companyId]);
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