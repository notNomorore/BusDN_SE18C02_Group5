const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const normalizeText = (value) => String(value || '').trim();

const isLoopbackHost = (hostname) => {
    const host = normalizeText(hostname).toLowerCase();
    return LOOPBACK_HOSTS.has(host);
};

const normalizeOrigin = (value, { allowLoopback = false } = {}) => {
    const raw = normalizeText(value);
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        if (!allowLoopback && isLoopbackHost(parsed.hostname)) {
            return '';
        }
        return parsed.origin.replace(/\/$/, '');
    } catch {
        return '';
    }
};

const normalizeAbsoluteUrl = (value, { allowLoopback = false } = {}) => {
    const raw = normalizeText(value);
    if (!raw) return '';

    try {
        const parsed = new URL(raw);
        if (!allowLoopback && isLoopbackHost(parsed.hostname)) {
            return '';
        }
        return parsed.toString();
    } catch {
        return '';
    }
};

const buildRequestOrigin = (req, { allowLoopback = false } = {}) => {
    if (!req) return '';

    const forwardedProto = normalizeText(req.get?.('x-forwarded-proto')).split(',')[0].trim();
    const forwardedHost = normalizeText(req.get?.('x-forwarded-host')).split(',')[0].trim();
    const host = forwardedHost || normalizeText(req.get?.('host')).split(',')[0].trim();
    const protocol = forwardedProto || normalizeText(req.protocol) || 'http';

    if (!host) return '';
    return normalizeOrigin(`${protocol}://${host}`, { allowLoopback });
};

const resolvePublicBackendBaseUrl = (req) => {
    const allowLoopback = process.env.NODE_ENV !== 'production';
    const candidates = [
        process.env.APP_BASE_URL,
        process.env.BACKEND_URL,
        process.env.RENDER_EXTERNAL_URL,
        buildRequestOrigin(req, { allowLoopback })
    ];

    for (const candidate of candidates) {
        const normalized = normalizeOrigin(candidate, { allowLoopback });
        if (normalized) return normalized;
    }

    return buildRequestOrigin(req, { allowLoopback: true }) || 'http://localhost:3000';
};

const resolvePublicAbsoluteUrl = (req, explicitUrl, fallbackPath) => {
    const allowLoopback = process.env.NODE_ENV !== 'production';
    const normalizedExplicitUrl = normalizeAbsoluteUrl(explicitUrl, { allowLoopback });
    if (normalizedExplicitUrl) return normalizedExplicitUrl;

    const baseUrl = resolvePublicBackendBaseUrl(req);
    return new URL(fallbackPath, `${baseUrl}/`).toString();
};

module.exports = {
    resolvePublicAbsoluteUrl,
    resolvePublicBackendBaseUrl
};
