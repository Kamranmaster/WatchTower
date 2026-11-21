import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { User } from '@monitorly/database';
import { buildApp, signedInAgent, useTestDatabase } from './helpers';

useTestDatabase();
const app = buildApp();

describe('POST /api/auth/register', () => {
  it('creates the account, hashes the password and sets an httpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Asha', email: '  Asha@Example.com ', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Asha', email: 'asha@example.com' });
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/monitorly_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const stored = await User.findOne({ email: 'asha@example.com' }).select('+passwordHash');
    expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt, never plaintext
    expect(stored?.passwordHash).not.toContain('correct-horse-battery');
  });

  it('rejects a duplicate email with 409', async () => {
    const body = { name: 'A', email: 'dup@example.com', password: 'correct-horse-battery' };
    await request(app).post('/api/auth/register').send(body).expect(201);
    const res = await request(app).post('/api/auth/register').send({ ...body, email: 'DUP@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.details[0].path).toBe('email');
  });

  it('validates input and reports which fields are wrong', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: '', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    const paths = res.body.details.map((d: { path: string }) => d.path).sort();
    expect(paths).toEqual(['email', 'name', 'password']);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with the right password', async () => {
    const { user } = await signedInAgent(app);
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const { user } = await signedInAgent(app);
    const wrong = await request(app).post('/api/auth/login').send({ email: user.email, password: 'wrong-password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'whatever1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
  });
});

describe('session', () => {
  it('GET /me works with the cookie and fails without it', async () => {
    const { agent, user } = await signedInAgent(app);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);

    await request(app).get('/api/auth/me').expect(401);
  });

  it('rejects a tampered token', async () => {
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.').expect(401);
  });

  it('logout clears the session', async () => {
    const { agent } = await signedInAgent(app);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });
});

describe('CSRF protection', () => {
  it('blocks state-changing requests from another origin', async () => {
    const { agent } = await signedInAgent(app);
    const res = await agent
      .post('/api/monitors')
      .set('Origin', 'https://evil.example.net')
      .send({ url: 'https://careers.example.com', instruction: 'new jobs please' });
    expect(res.status).toBe(403);
  });

  it('allows requests from the web app origin', async () => {
    const { agent } = await signedInAgent(app);
    const res = await agent
      .post('/api/monitors')
      .set('Origin', 'http://localhost:5173')
      .send({ url: 'https://careers.example.com', instruction: 'new jobs please' });
    expect(res.status).toBe(201);
  });
});
