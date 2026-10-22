'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AnthropicSseToOpenAI,
  convertAnthropicErrorToOpenAI,
  convertAnthropicResponseToOpenAI,
  convertOpenAIChatToAnthropic,
  isMessagesModel,
} = require('../src/protocol-converter');

test('recognizes only the Messages-protocol allowlist', () => {
  assert.equal(isMessagesModel('QWEN3.8-FLASH'), true);
  assert.equal(isMessagesModel('minimax-m3'), true);
  assert.equal(isMessagesModel('deepseek-v4-flash'), false);
});

test('converts an OpenAI chat request to Anthropic Messages', () => {
  const request = convertOpenAIChatToAnthropic({
    model: 'qwen3.8-flash',
    max_tokens: 999999999,
    stream: true,
    temperature: 1.5,
    top_p: -1,
    stop: ['END'],
    parallel_tool_calls: false,
    messages: [
      { role: 'system', content: 'System rule' },
      { role: 'developer', content: 'Developer rule' },
      { role: 'user', content: 'Use the tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"term":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup a term',
          parameters: {
            type: 'object',
            properties: { term: { type: 'string' } },
            required: ['term'],
          },
        },
      },
    ],
    tool_choice: 'required',
  });

  assert.equal(request.model, 'qwen3.8-flash');
  assert.equal(request.max_tokens, 16384);
  assert.equal(request.stream, true);
  assert.equal(request.temperature, 1);
  assert.equal(request.top_p, 0);
  assert.equal(request.system, 'System rule\n\nDeveloper rule');
  assert.deepEqual(request.tools[0].input_schema.required, ['term']);
  assert.deepEqual(request.tool_choice, {
    type: 'any',
    disable_parallel_tool_use: true,
  });
  assert.equal(request.messages[1].content[0].type, 'tool_use');
  assert.deepEqual(request.messages[1].content[0].input, { term: 'x' });
  assert.equal(request.messages[2].content[0].type, 'tool_result');
  assert.equal(request.stop_sequences[0], 'END');
});

test('converts an Anthropic response to OpenAI chat format', () => {
  const response = convertAnthropicResponseToOpenAI(
    {
      id: 'msg_123',
      model: 'qwen3.8-flash',
      content: [
        { type: 'thinking', thinking: 'Reason' },
        { type: 'text', text: 'Answer' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup',
          input: { term: 'x' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
      },
    },
    'fallback',
  );

  assert.equal(response.object, 'chat.completion');
  assert.equal(response.choices[0].message.content, 'Answer');
  assert.equal(response.choices[0].message.reasoning_content, 'Reason');
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.equal(
    response.choices[0].message.tool_calls[0].function.arguments,
    '{"term":"x"}',
  );
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.usage.prompt_tokens, 13);
  assert.equal(response.usage.total_tokens, 17);
});

test('converts split Anthropic SSE frames, reasoning, and tool calls', () => {
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          model: 'qwen3.8-flash',
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '思考' },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_stream',
          name: 'lookup',
          input: {},
        },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"term":' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      },
    ],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 8 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  const source = events
    .map(
      ([name, payload]) =>
        'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n',
    )
    .join('');
  const bytes = Buffer.from(source);
  const translator = new AnthropicSseToOpenAI('fallback');
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 7) {
    output += translator.push(bytes.subarray(offset, offset + 7));
  }
  output += translator.end();

  assert.match(output, /"role":"assistant"/);
  assert.match(output, /"reasoning_content":"思考"/);
  assert.match(output, /"id":"toolu_stream"/);
  const streamedArguments = output
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
    .flatMap((payload) => payload.choices?.[0]?.delta?.tool_calls || [])
    .map((toolCall) => toolCall.function?.arguments || '')
    .join('');
  assert.equal(streamedArguments, '{"term":"x"}');
  assert.match(output, /"finish_reason":"tool_calls"/);
  assert.equal(output.match(/data: \[DONE\]/g)?.length, 1);
});

test('normalizes Anthropic errors without leaking unrelated fields', () => {
  assert.deepEqual(
    convertAnthropicErrorToOpenAI(
      {
        error: {
          type: 'invalid_request_error',
          message: 'bad request',
          private: 'must-not-be-forwarded',
        },
      },
      400,
    ),
    {
      error: {
        message: 'bad request',
        type: 'invalid_request_error',
        param: null,
        code: '400',
      },
    },
  );
});
