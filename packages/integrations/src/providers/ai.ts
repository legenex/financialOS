import type { ProviderDescriptor } from '@financialos/contracts';
import { ANTHROPIC_DEFAULT_BASE_URL, ANTHROPIC_VERSION } from '../adapters/ai';
import { CHECKED_ON, capabilities, numberField, readOnlyMethod, secretField, textField, unverifiedHistory, urlField, yes } from './support';

const PRIVACY_NOTE =
  'Privacy gating happens before a call is made, not inside the client. The connection carries locality (local or cloud) and whether identifiable data may be sent; the caller checks both and redacts accordingly. These clients send exactly the messages they are given.';

export const aiOpenAiCompatibleProvider: ProviderDescriptor = {
  key: 'ai_openai_compatible',
  name: 'OpenAI-compatible model endpoint',
  category: 'ai',
  regions: ['Global'],
  summary:
    'Any endpoint that speaks the OpenAI chat-completions API: a local gateway on this host, a self-hosted server, or a cloud vendor. Streaming, cancellation, and token usage are captured.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    `Verified on 2026-09-18 against OpenAI's official specification at https://github.com/openai/openai-openapi : POST {base}/chat/completions with Authorization: Bearer, a data-only SSE stream terminated by "data: [DONE]", deltas at choices[0].delta.content, stream_options.include_usage adding a final usage-only chunk, non-streaming usage of { prompt_tokens, completion_tokens, total_tokens }, and GET {base}/models returning { object: "list", data: [{ id, object, created, owned_by }] }. The request uses max_completion_tokens, which the specification marks as the replacement for the deprecated max_tokens. The connection test lists models, so it proves the credential without spending tokens. ${PRIVACY_NOTE}`,
  methods: [
    readOnlyMethod({
      method: 'openai_compatible',
      label: 'API key',
      description: 'An API key and a base URL. The model id is chosen per task; this client has no default model.',
      fields: [
        urlField('baseUrl', 'Base URL', 'For example http://127.0.0.1:4000/v1 for a local gateway, or the vendor base URL. Include the version path segment if the endpoint uses one.'),
        secretField('apiKey', 'API key', 'Stored encrypted and sent only in the Authorization header, never in a URL.'),
        textField('model', 'Model id', 'The model this connection routes to. There is no default: a hardcoded id goes stale and quietly misroutes work.'),
        numberField('timeoutMs', 'Timeout (ms)', 'How long to wait for a response. Default 120000.'),
      ],
      ownerActivationSteps: [
        'Decide whether this endpoint is local or cloud and set the locality on the connection accordingly. It drives what data may reach it.',
        'For a local gateway on this host, add its loopback host and port to the outbound allowlist in Settings. Nothing is reached on a host you have not allowed.',
        'Enter the base URL including any version path, the API key, and the model id.',
        'Press Test. It lists the models the endpoint exposes, which proves the key without spending tokens.',
        'Decide separately, in AI settings, whether identifiable financial data may be sent to this connection. Cloud connections start with that switched off.',
      ],
      capabilities: capabilities({ agentContext: yes('Chat completions with streaming, cancellation, and captured token usage.') }),
      historyLimit: unverifiedHistory(null, 'Not applicable to a model endpoint.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://platform.openai.com/docs/api-reference/chat', 'https://github.com/openai/openai-openapi'],
      unsupportedProducts: [
        'Tool calling, images, audio, and structured outputs are not wired up in this release; the client sends text messages and reads text back.',
        'A model never performs arithmetic of record: numbers come from the tested engine, not from a completion.',
      ],
      scheduleSupported: false,
    }),
  ],
};

export const aiAnthropicProvider: ProviderDescriptor = {
  key: 'ai_anthropic',
  name: 'Anthropic',
  category: 'ai',
  regions: ['Global'],
  summary: 'The Anthropic Messages API. Streaming, cancellation, and token usage are captured; the model id is always supplied by the caller.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    `Verified on 2026-09-18 against https://platform.claude.com/docs/en/api/messages and .../api/versioning : POST ${ANTHROPIC_DEFAULT_BASE_URL}/v1/messages with the x-api-key header and anthropic-version: ${ANTHROPIC_VERSION} (the current documented version), max_tokens required, content returned as [{ type: "text", text }], usage as { input_tokens, output_tokens, ... }, and the streaming events message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop, ping, and error. The docs state that message_delta usage counts are cumulative, so the last one is taken. GET /v1/models lists available models and is used as the connection test. The client has no built-in model id on purpose. ${PRIVACY_NOTE}`,
  methods: [
    readOnlyMethod({
      method: 'openai_compatible',
      label: 'API key (Messages API)',
      description: 'An Anthropic API key. The Messages API shape is used, not the OpenAI one, despite the shared method name in the contract.',
      fields: [
        secretField('apiKey', 'API key', 'Stored encrypted and sent only in the x-api-key header.'),
        textField('model', 'Model id', 'The model this connection routes to. Pick it from the model list shown after a successful test; there is no default.'),
        urlField('baseUrl', 'Base URL', `Override only for a proxy you control. Default ${ANTHROPIC_DEFAULT_BASE_URL}.`, false),
        numberField('timeoutMs', 'Timeout (ms)', 'How long to wait for a response. Default 120000.'),
      ],
      ownerActivationSteps: [
        'Create an API key in the Anthropic console for the workspace you want this deployment to bill.',
        'Add api.anthropic.com to the outbound allowlist in Settings.',
        'Enter the key here and press Test. The test lists available models; choose one and save it as this connection\'s model id.',
        'Set a monthly budget on the connection so a runaway task cannot spend without limit.',
        'This is a cloud connection. Identifiable financial data is not sent to it unless you explicitly switch that on in AI settings.',
      ],
      capabilities: capabilities({ agentContext: yes('Messages API calls with streaming, cancellation, and captured token usage.') }),
      historyLimit: unverifiedHistory(null, 'Not applicable to a model endpoint.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://docs.claude.com/en/api/messages', 'https://docs.claude.com/en/api/versioning', 'https://docs.claude.com/en/docs/build-with-claude/streaming'],
      unsupportedProducts: [
        'Tool use, extended thinking, batches, files, and the citations API are not wired up in this release.',
        'Coding-assistant credentials are never reused as application inference credentials; this connection needs its own API key.',
        'A model never performs arithmetic of record.',
      ],
      scheduleSupported: false,
    }),
  ],
};
