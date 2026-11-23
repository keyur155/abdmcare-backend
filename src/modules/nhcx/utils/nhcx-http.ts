import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import crypto from 'crypto';
import https from 'https';
import dns from 'dns';
import logger from '@common/config/logger'; 
import prisma from '@common/config/database';
import { nhcxConfig } from '@common/config/nhcx';


try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* node < 17 */ }

const ipv4HttpsAgent = new https.Agent({
  family: 4,
  keepAlive: true,
  keepAliveMsecs: 30_000,
});



// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AbdmV3SessionResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  tokenType: string;
}

const SESSION_ENDPOINTS = [
  `${process.env.ABDM_SESSIONS_URL || 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions'}`,
];

export class NhcxHttp {
  private axiosInstance: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiryTime: number = 0;
  private publicKey: string | null = null;

  constructor() {
    this.axiosInstance = axios.create({
      timeout: nhcxConfig.timeout,
      headers: { 'Content-Type': 'application/json' },
      httpsAgent: ipv4HttpsAgent, // Force IPv4 to bypass per-edge CloudFront WAF on abhasbx
    });
    this.setupInterceptors();
  }

//   setup interceptors
 private setupInterceptors(): void {
    this.axiosInstance.interceptors.request.use((config) => {
      (config as any)._startTime = Date.now();
      return config;
    });

    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.logTransaction(response.config, response);
        return response;
      },
      async (error) => {
        this.logTransaction(error.config, error.response, error);
        const retried = (error.config as any)?._retried;
        if (error.response?.status === 401 && !retried) {
          logger.warn('[ABDM-INTERCEPTOR] Got 401, re-authenticating (one retry)...');
          this.accessToken = null;
          this.tokenExpiryTime = 0;
          error.config._retried = true;
          await this.authenticate();
          return this.axiosInstance.request(error.config);
        }
        return Promise.reject(error);
      }
    );
  }


//   logging

 private async logTransaction(
    config: AxiosRequestConfig,
    response?: AxiosResponse,
    error?: any
  ): Promise<void> {
    try {
      let requestPayload = {};
      try { requestPayload = typeof config.data === 'string' ? JSON.parse(config.data) : config.data || {}; } catch { requestPayload = {}; }

      const startTime = (config as any)?._startTime;
      const duration = startTime ? Date.now() - startTime : null;

      await prisma.abdmTransaction.create({
        data: {
          transactionId: crypto.randomUUID(),
          requestId: (config.headers?.['REQUEST-ID'] as string) || null,
          apiEndpoint: config.url || '',
          method: config.method?.toUpperCase() || 'GET',
          requestPayload,
          responsePayload: response?.data || null,
          statusCode: response?.status ?? error?.response?.status ?? null,
          success: !!response && response.status >= 200 && response.status < 300,
          errorMessage: error?.message || null,
          duration,
        },
      });
    } catch (err: any) {
      logger.error('Failed to log ABDM transaction', { message: err?.message });
    }
  }

//  retriving token 
   private async authenticate(): Promise<void> {
    const payload = {
      clientId: nhcxConfig,
      clientSecret: nhcxConfig.clientSecret,
      grantType: 'client_credentials',
    };

    logger.info('[ABDM-AUTH] Starting authentication', {
      clientId: nhcxConfig.clientId || '(EMPTY)',
      hasSecret: !!nhcxConfig.clientSecret,
      endpoints: SESSION_ENDPOINTS,
    });

    for (const endpoint of SESSION_ENDPOINTS) {
      try {
        logger.info(`[ABDM-AUTH] Trying endpoint: ${endpoint}`);
        const response = await axios.post<AbdmV3SessionResponse>(
          endpoint,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'REQUEST-ID': crypto.randomUUID(),
              'TIMESTAMP': new Date().toISOString(),
              'X-CM-ID': nhcxConfig.cmId || 'sbx',
            },
            timeout: nhcxConfig.timeout,
            httpsAgent: ipv4HttpsAgent,
          }
        );
        // ABDM sandbox sometimes returns HTTP 200 with an error body instead of 4xx
        if ((response.data as any).error || !(response.data as any).accessToken) {
          const errMsg = (response.data as any).error?.message
            || (response.data as any).error?.code
            || 'No accessToken in response';
          logger.error(`[ABDM-AUTH] Got HTTP 200 but no token from ${endpoint}`, { body: JSON.stringify(response.data).substring(0, 200) });
          throw new Error(`ABDM auth error: ${errMsg}`);
        }

        this.accessToken = response.data.accessToken;
        this.tokenExpiryTime = Date.now() + (response.data.expiresIn || 1800) * 1000 - 60_000;
        logger.info(`[ABDM-AUTH] SUCCESS via ${endpoint}`, {
          tokenPreview: this.accessToken?.substring(0, 20) + '...',
          expiresIn: response.data.expiresIn,
        });
        return;
      } catch (error: any) {
        logger.error(`[ABDM-AUTH] FAILED on ${endpoint}`, {
          status: error?.response?.status,
          statusText: error?.response?.statusText,
          data: JSON.stringify(error?.response?.data)?.substring(0, 500),
          message: error?.message,
          code: error?.code,
        });
      }
    }

    logger.error('[ABDM-AUTH] ALL endpoints failed', {
      clientId: nhcxConfig.clientId || '(EMPTY)',
    });
    throw new Error('Failed to authenticate with ABDM gateway');
  }

  
}