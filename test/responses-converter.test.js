'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ResponsesSseToOpenAI,
  convertOpenAIChatToResponses,
  convertResponsesErrorToOpenAI,
  convertResponsesResponseToOpenAI,
} = require('../src/responses-converter');

test('converts a chat request (system + tools + history) to Responses input', () => {
  const result = convertOpenAIChatToResponses({
    model: 'gpt-6-luna',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Shanghai?' },
      {
        role: 'assistant',
        content: '',
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
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: 512,
    temperature: 0.2,
    stream: true,
  });

  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.instructions, 'be terse');
  assert.equal(result.max_output_tokens, 512);
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
  assert.equal(result.temperature, 0.2);
  assert.deepEqual(result.input[0], {
    role: 'user',
    content: [{ type: 'input_text', text: 'weather in Shanghai?' }],
  });
  assert.deepEqual(result.input[1], {
    type: 'function_call',
    call_id: 'call_abc',
    name: 'get_weather',
    arguments: '{"city":"Shanghai"}',
  });
  assert.deepEqual(result.input[2], {
    type: 'function_call_output',
    call_id: 'call_abc',
    output: '{"temp":21}',
  });
  assert.deepEqual(result.tools, [
    {
      type: 'function',
      name: 'get_weather',
      description: 'look up weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ]);
  assert.equal(result.tool_choice, 'auto');
});

test('defaults max_output_tokens and drops chat-only fields', () => {
  const result = convertOpenAIChatToResponses({
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    stream_options: { include_usage: true },
    n: 2,
    logprobs: true,
  });
  assert.equal(result.max_output_tokens, 8192);
  assert.equal(result.stream_options, undefined);
  assert.equal(result.n, undefined);
  assert.equal(result.store, false);
});

test('converts a non-stream Responses payload into chat.completion', () => {
  const converted = convertResponsesResponseToOpenAI(
    {
      id: 'resp_123',
      object: 'response',
      created_at: 1730000000,
      model: 'gpt-6-luna',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking hard' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello there.' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'ping',
          arguments: '{"x":1}',
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
        input_tokens_details: { cached_tokens: 4 },
      },
    },
    'fallback-model',
  );

  assert.equal(converted.object, 'chat.completion');
  assert.equal(converted.id, 'resp_123');
  assert.equal(converted.model, 'gpt-6-luna');
  assert.equal(converted.choices[0].finish_reason, 'tool_calls');
  assert.equal(converted.choices[0].message.content, 'Hello there.');
  assert.equal(converted.choices[0].message.reasoning_content, 'thinking hard');
  assert.deepEqual(converted.choices[0].message.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'ping', arguments: '{"x":1}' },
    },
  ]);
  assert.deepEqual(converted.usage, {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 4 },
  });
});

test('maps an incomplete response to finish_reason=length', () => {
  const converted = convertResponsesResponseToOpenAI({
    id: 'resp_x',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
  });
  assert.equal(converted.choices[0].finish_reason, 'length');
  assert.equal(converted.choices[0].message.content, 'partial');
});

test('translates streamed Responses events into chat chunks', () => {
  const translator = new ResponsesSseToOpenAI('gpt-6-luna');
  const frames = [
    ['response.created', { type: 'response.created', response: { id: 'resp_s', model: 'gpt-6-luna' } }],
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
    }],
    ['response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      delta: 'Hel',
    }],
    ['response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      delta: 'lo',
    }],
    ['response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'ping', arguments: '' },
    }],
    ['response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      delta: '{"x":',
    }],
    ['response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      delta: '1}',
    }],
    ['response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_s',
        model: 'gpt-6-luna',
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    }],
  ];
  const raw = frames
    .map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join('');

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
  assert.equal(content, 'Hello');

  const toolChunk = chunks.find((c) => c !== '[DONE]' && c.choices?.[0]?.delta?.tool_calls);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].id, 'call_9');
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'ping');

  const finish = chunks.find((c) => c !== '[DONE]' && c.choices?.[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  assert.equal(finish.usage.prompt_tokens, 5);
  assert.equal(finish.usage.completion_tokens, 3);
  assert.equal(chunks.at(-1), '[DONE]');
});

test('streams full tool arguments when upstream sends no deltas', () => {
  const translator = new ResponsesSseToOpenAI('gpt-6-luna');
  const raw = [
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'ping', arguments: '' },
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'ping', arguments: '{"a":2}' },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_t', status: 'completed', output: [] },
    })}\n\n`,
  ].join('');

  const output = translator.push(raw) + translator.end();
  assert.match(output, /"arguments":"\{\\"a\\":2\}"/);
  assert.match(output, /"finish_reason":"tool_calls"/);
});

test('wraps upstream errors in the OpenAI error envelope', () => {
  const converted = convertResponsesErrorToOpenAI(
    { error: { message: 'Invalid credential', type: 'server_error' } },
    401,
  );
  assert.deepEqual(converted, {
    error: {
      message: 'Invalid credential',
      type: 'server_error',
      param: null,
      code: '401',
    },
  });
});

test('max_tokens below the Responses floor is lifted to 16', () => {
  const one = convertOpenAIChatToResponses({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 1,
  });
  assert.equal(one.max_output_tokens, 16);
  const five = convertOpenAIChatToResponses({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 5,
  });
  assert.equal(five.max_output_tokens, 16);
  const big = convertOpenAIChatToResponses({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 512,
  });
  assert.equal(big.max_output_tokens, 512);
});

test('minimal reasoning effort is folded onto low for Responses models', () => {
  const minimal = convertOpenAIChatToResponses({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'minimal',
  });
  assert.deepEqual(minimal.reasoning, { effort: 'low' });
  const high = convertOpenAIChatToResponses({
    model: 'gpt-6-luna',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  });
  assert.deepEqual(high.reasoning, { effort: 'high' });
});
