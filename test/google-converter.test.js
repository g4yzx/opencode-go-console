'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GoogleSseToOpenAI,
  convertGoogleErrorToOpenAI,
  convertGoogleResponseToOpenAI,
  convertOpenAIChatToGoogle,
  sanitizeSchema,
} = require('../src/google-converter');

test('converts a chat request into generateContent contents', () => {
  const result = convertOpenAIChatToGoogle({
    model: 'gemini-4-argon-contributor',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Shanghai?' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":21}' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'look up weather',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: {
              city: { type: 'string', description: 'city name' },
              days: { type: 'integer', minimum: 1 },
            },
            required: ['city'],
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    max_tokens: 256,
    temperature: 0.3,
    stop: ['END'],
  });

  assert.deepEqual(result.systemInstruction, { parts: [{ text: 'be terse' }] });
  assert.deepEqual(result.contents[0], {
    role: 'user',
    parts: [{ text: 'weather in Shanghai?' }],
  });
  assert.deepEqual(result.contents[1], {
    role: 'model',
    parts: [
      { text: 'checking' },
      { functionCall: { name: 'get_weather', args: { city: 'Shanghai' } } },
    ],
  });
  assert.deepEqual(result.contents[2], {
    role: 'user',
    parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }],
  });
  assert.deepEqual(result.tools, [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'look up weather',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string', description: 'city name' },
              days: { type: 'integer', minimum: 1 },
            },
            required: ['city'],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(result.toolConfig, {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
  });
  assert.equal(result.generationConfig.maxOutputTokens, 256);
  assert.equal(result.generationConfig.temperature, 0.3);
  assert.deepEqual(result.generationConfig.stopSequences, ['END']);
});

test('maps image parts and rejects unsupported schema keywords', () => {
  const result = convertOpenAIChatToGoogle({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'noop',
          parameters: { type: 'object', additionalProperties: true, oneOf: [{ type: 'string' }] },
        },
      },
    ],
  });
  assert.deepEqual(result.contents[0].parts, [
    { text: 'what is this' },
    { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
  ]);
  assert.deepEqual(sanitizeSchema(result.tools[0].functionDeclarations[0].parameters), {
    type: 'object',
  });
  assert.equal(result.tools[0].functionDeclarations[0].parameters.oneOf, undefined);
});

test('converts a generateContent response into chat.completion', () => {
  const converted = convertGoogleResponseToOpenAI(
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Hello ' },
              { text: 'there.' },
              { functionCall: { name: 'ping', args: { x: 1 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 2,
        totalTokenCount: 15,
        cachedContentTokenCount: 3,
      },
      modelVersion: 'gemini-4-argon-contributor',
    },
    'fallback',
  );

  assert.equal(converted.object, 'chat.completion');
  assert.equal(converted.model, 'gemini-4-argon-contributor');
  assert.equal(converted.choices[0].message.content, 'Hello there.');
  assert.equal(converted.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(converted.choices[0].message.tool_calls[0].function, {
    name: 'ping',
    arguments: '{"x":1}',
  });
  assert.equal(converted.usage.prompt_tokens, 9);
  assert.equal(converted.usage.completion_tokens, 6);
  assert.equal(converted.usage.total_tokens, 15);
  assert.deepEqual(converted.usage.prompt_tokens_details, { cached_tokens: 3 });
  assert.deepEqual(converted.usage.completion_tokens_details, { reasoning_tokens: 2 });
});

test('maps MAX_TOKENS and safety blocks to OpenAI finish reasons', () => {
  const truncated = convertGoogleResponseToOpenAI({
    candidates: [{ content: { parts: [{ text: 'part' }] }, finishReason: 'MAX_TOKENS' }],
  });
  assert.equal(truncated.choices[0].finish_reason, 'length');

  const blocked = convertGoogleResponseToOpenAI({
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: [],
  });
  assert.equal(blocked.choices[0].finish_reason, 'content_filter');
  assert.equal(blocked.choices[0].message.content, '');
});

test('translates streamed generateContent chunks', () => {
  const translator = new GoogleSseToOpenAI('gemini-4-argon-contributor');
  const frames = [
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }],
      modelVersion: 'gemini-4-argon-contributor',
    },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] } }] },
    {
      candidates: [
        { content: { role: 'model', parts: [{ text: '!' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    },
  ];
  const raw = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
  const output = translator.push(raw) + translator.end();
  const chunks = output
    .split('\n\n')
    .map((frame) => frame.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));

  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const content = chunks
    .filter((c) => c !== '[DONE]' && c.choices?.[0]?.delta?.content)
    .map((c) => c.choices[0].delta.content)
    .join('');
  assert.equal(content, 'Hello!');
  const finish = chunks.find((c) => c !== '[DONE]' && c.choices?.[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, 'stop');
  assert.equal(finish.usage.prompt_tokens, 3);
  assert.equal(chunks.at(-1), '[DONE]');
});

test('wraps Google errors in the OpenAI error envelope', () => {
  const converted = convertGoogleErrorToOpenAI(
    { error: { code: 400, status: 'UNKNOWN', message: 'This Go model trains on request data.' } },
    400,
  );
  assert.deepEqual(converted, {
    error: {
      message: 'This Go model trains on request data.',
      type: 'UNKNOWN',
      param: null,
      code: '400',
    },
  });
});
