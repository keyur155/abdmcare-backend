
const GATEWAY_BASE = process.env.ABDM_GATEWAY_BASE || 'https://dev.abdm.gov.in';

export const nhcxConfig = {
  gatewayUrl: process.env.ABDM_GATEWAY_URL || `${GATEWAY_BASE}/api/hiecm/gateway/v3`,

  enabled: process.env.NHCX_ENABLED === 'true',

  environment: process.env.NHCX_ENV || 'sandbox',

  baseUrl: process.env.NHCX_BASE_URL || '',

  sessionUrl: process.env.NHCX_SESSION_URL || '',

  // ── Client credentials ─────────────────────────────────────────────────────
  clientId: process.env.ABDM_CLIENT_ID || '',
  clientSecret: process.env.ABDM_CLIENT_SECRET || '',
  callbackUrl: process.env.ABDM_CALLBACK_URL || '',
  cmId: process.env.ABDM_CM_ID || 'sbx',

  // Provider participant details
  participant: {
    id: process.env.NHCX_PARTICIPANT_ID || '',
    code: process.env.NHCX_PARTICIPANT_CODE || '',
    type: 'provider',
  },

  // CRYPTO
  privateKeyPath: process.env.NHCX_PRIVATE_KEY_PATH || '',

  publicKeyPath: process.env.NHCXPUBLIC_KEY_PATH || '',

  certificatePath: process.env.NGCX_CERT_PATH || '',

  // callback

  callbackBaseUrl: process.env.NHCX_CALLBACK_URL || process.env.ABDM_CALLBACK_URL || '',

  // Scheme configuration
  schemes: ['PMJAY', 'PRIVATE'],

  encodeURI: {},
  timeout: 30000,

};

