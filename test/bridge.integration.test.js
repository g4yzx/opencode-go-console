'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const bridgePath = path.join(projectRoot, 'src', 'bridge.js');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function requestJson(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method,
        headers: {
          ...(data
            ? {
                'content-type': 'application/json',
                'content-length': String(data.length),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            // Some assertions intentionally inspect non-JSON output.
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (data) req.end(data);
    else req.end();
  });
}

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error('bridge exited early with code ' + child.exitCode);
    }
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.status === 200 && response.json?.ok === true) return;
    } catch {
      // Startup may still be in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bridge did not become healthy');
}

test('bridge routes chat and converts Messages models safely', async (t) => {
  const captured = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      captured.push({ url: req.url, headers: req.headers, body });

      if (req.url.startsWith('/inference/go/anthropic/v1/messages')) {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const frames = [
            [
              'message_start',
              {
                type: 'message_start',
                message: {
                  id: 'msg_mock_stream',
                  model: body.model,
                  usage: { input_tokens: 2, output_tokens: 0 },
                },
              },
            ],
            [
              'content_block_delta',
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'OK' },
              },
            ],
            [
              'message_delta',
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 1 },
              },
            ],
            ['message_stop', { type: 'message_stop' }],
          ];
          for (const [event, payload] of frames) {
            res.write(
              'event: ' +
                event +
                '\ndata: ' +
                JSON.stringify(payload) +
                '\n\n',
            );
          }
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            model: body.model,
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
        );
        return;
      }

      if (req.url.startsWith('/inference/go/google/v1beta/models/')) {
        const streaming = req.url.includes(':streamGenerateContent');
        const chunks = [
          {
            candidates: [{ content: { role: 'model', parts: [{ text: 'O' }] } }],
            modelVersion: body.model,
          },
          { candidates: [{ content: { role: 'model', parts: [{ text: 'K' }] } }] },
        ];
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const chunk of chunks) {
            res.write('data: ' + JSON.stringify(chunk) + '\n\n');
          }
          res.write(
            'data: ' +
              JSON.stringify({
                candidates: [
                  { content: { role: 'model', parts: [] }, finishReason: 'STOP' },
                ],
                usageMetadata: {
                  promptTokenCount: 2,
                  candidatesTokenCount: 1,
                  totalTokenCount: 3,
                },
              }) +
              '\n\n',
          );
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'OK' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 1,
              totalTokenCount: 3,
            },
            modelVersion: body.model,
          }),
        );
        return;
      }

      if (req.url.startsWith('/inference/go/openai/v1/responses')) {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const frames = [
            [
              'response.created',
              {
                type: 'response.created',
                response: { id: 'resp_mock_stream', model: body.model },
              },
            ],
            [
              'response.output_item.added',
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
              },
            ],
            [
              'response.output_text.delta',
              {
                type: 'response.output_text.delta',
                item_id: 'msg_1',
                output_index: 0,
                delta: 'OK',
              },
            ],
            [
              'response.completed',
              {
                type: 'response.completed',
                response: {
                  id: 'resp_mock_stream',
                  model: body.model,
                  status: 'completed',
                  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
                },
              },
            ],
          ];
          for (const [event, payload] of frames) {
            res.write(
              'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n',
            );
          }
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp_mock',
            object: 'response',
            model: body.model,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'OK' }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_mock',
          object: 'chat.completion',
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OK' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const bridgePort = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-go-bridge-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [bridgePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENCODE_GO_BRIDGE_PORT: String(bridgePort),
      OPENCODE_GO_BRIDGE_STATE_DIR: stateDir,
      OPENCODE_GO_UPSTREAM_ORIGIN:
        'http://127.0.0.1:' + upstreamPort,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
  });
  await waitForHealth(bridgePort, child);

  const health = await requestJson(bridgePort, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'opencode-go-bridge');
  assert.equal(health.json.listen, '127.0.0.1:' + bridgePort);

  const models = await requestJson(bridgePort, 'GET', '/v1/models');
  assert.equal(models.status, 200);
  assert.ok(models.json.data.some((entry) => entry.id === 'qwen3.8-flash'));

  const direct = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Reply OK' }],
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(direct.status, 200);
  assert.equal(direct.json.object, 'chat.completion');
  const directCapture = captured.at(-1);
  assert.equal(directCapture.url, '/inference/go/openai/v1/chat/completions');
  assert.match(directCapture.headers['x-opencode-session'], /^derived-/);
  assert.equal(
    directCapture.headers.authorization,
    'Bearer test-only-token',
  );

  const converted = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'qwen3.8-flash',
      messages: [{ role: 'user', content: 'Reply OK' }],
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(converted.status, 200);
  assert.equal(converted.json.object, 'chat.completion');
  assert.equal(converted.json.choices[0].message.content, 'OK');
  const convertedCapture = captured.at(-1);
  assert.equal(convertedCapture.url, '/inference/go/anthropic/v1/messages');
  assert.equal(convertedCapture.headers['x-api-key'], 'test-only-token');
  assert.equal(convertedCapture.headers.authorization, undefined);
  assert.equal(convertedCapture.headers['anthropic-version'], '2023-06-01');
  assert.match(convertedCapture.headers['x-opencode-session'], /^derived-/);

  const streamed = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'qwen3.8-flash',
      stream: true,
      messages: [{ role: 'user', content: 'Reply OK' }],
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers['content-type'], /^text\/event-stream/);
  assert.match(streamed.raw, /"content":"OK"/);
  assert.match(streamed.raw, /data: \[DONE\]/);

  const responsesConverted = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'Reply OK' },
      ],
      max_tokens: 64,
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(responsesConverted.status, 200);
  assert.equal(responsesConverted.json.choices[0].message.content, 'OK');
  assert.equal(responsesConverted.json.choices[0].finish_reason, 'stop');
  assert.equal(responsesConverted.json.usage.prompt_tokens, 2);
  const responsesCapture = captured.at(-1);
  assert.equal(responsesCapture.url, '/inference/go/openai/v1/responses');
  assert.equal(responsesCapture.body.instructions, 'be terse');
  assert.equal(responsesCapture.body.max_output_tokens, 64);
  assert.equal(responsesCapture.body.store, false);
  assert.deepEqual(responsesCapture.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Reply OK' }] },
  ]);
  assert.equal(responsesCapture.headers.authorization, 'Bearer test-only-token');
  assert.match(responsesCapture.headers['x-opencode-session'], /^derived-/);

  const responsesStreamed = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'gpt-6-luna',
      stream: true,
      messages: [{ role: 'user', content: 'Reply OK' }],
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(responsesStreamed.status, 200);
  assert.match(responsesStreamed.headers['content-type'], /^text\/event-stream/);
  assert.match(responsesStreamed.raw, /"content":"OK"/);
  assert.match(responsesStreamed.raw, /data: \[DONE\]/);

  const googleConverted = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'gemini-4-argon-contributor',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'Reply OK' },
      ],
      max_tokens: 32,
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(googleConverted.status, 200);
  assert.equal(googleConverted.json.choices[0].message.content, 'OK');
  assert.equal(googleConverted.json.usage.prompt_tokens, 2);
  const googleCapture = captured.at(-1);
  assert.match(
    googleCapture.url,
    /^\/inference\/go\/google\/v1beta\/models\/gemini-4-argon-contributor:generateContent$/,
  );
  assert.equal(googleCapture.body.systemInstruction.parts[0].text, 'be terse');
  assert.deepEqual(googleCapture.body.contents, [
    { role: 'user', parts: [{ text: 'Reply OK' }] },
  ]);
  assert.equal(googleCapture.body.generationConfig.maxOutputTokens, 32);
  assert.equal(googleCapture.headers.authorization, 'Bearer test-only-token');

  const googleStreamed = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'gemini-4-argon-contributor',
      stream: true,
      messages: [{ role: 'user', content: 'Reply OK' }],
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(googleStreamed.status, 200);
  assert.match(googleStreamed.headers['content-type'], /^text\/event-stream/);
  assert.match(googleStreamed.raw, /"content":"O"/);
  assert.match(googleStreamed.raw, /"content":"K"/);
  assert.match(googleStreamed.raw, /data: \[DONE\]/);
  assert.match(captured.at(-1).url, /:streamGenerateContent\?alt=sse$/);

  const unsupported = await requestJson(
    bridgePort,
    'POST',
    '/v1/chat/completions',
    {
      model: 'unverified-model',
      messages: [{ role: 'user', content: 'test' }],
    },
    { authorization: 'Bearer test-only-token' },
  );
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.error.code, 'unsupported_model');
  assert.equal(
    captured.some((entry) => entry.body.model === 'unverified-model'),
    false,
  );

  const missing = await requestJson(bridgePort, 'GET', '/private');
  assert.equal(missing.status, 404);

  const diagnostic = fs.readFileSync(
    path.join(stateDir, 'diagnostic.log'),
    'utf8',
  );
  assert.doesNotMatch(diagnostic, /test-only-token|Reply OK/);

  const rejectedShutdown = await requestJson(
    bridgePort,
    'POST',
    '/shutdown',
    undefined,
    { 'x-bridge-shutdown-token': 'wrong-token' },
  );
  assert.equal(rejectedShutdown.status, 403);

  const shutdownToken = fs
    .readFileSync(path.join(stateDir, 'shutdown.token'), 'utf8')
    .trim();
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  const shutdown = await requestJson(
    bridgePort,
    'POST',
    '/shutdown',
    undefined,
    { 'x-bridge-shutdown-token': shutdownToken },
  );
  assert.equal(shutdown.status, 202);
  const exitCode = await Promise.race([
    exitPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('shutdown timeout')), 2000),
    ),
  ]);
  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(path.join(stateDir, 'bridge.pid')), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'shutdown.token')), false);
});
