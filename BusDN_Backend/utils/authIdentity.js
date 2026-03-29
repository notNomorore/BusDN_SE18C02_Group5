const normalizeText = (value) => (value ?? '').toString().trim();

const normalizeEmail = (value) => normalizeText(value).toLowerCase();

const normalizePhone = (value) => normalizeText(value).replace(/[^\d+]/g, '');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildEmailRegex = (value) => {
    const email = normalizeEmail(value);
    if (!email) return null;

    return new RegExp(`^${escapeRegex(email)}$`, 'i');
};

const buildPhoneVariants = (value) => {
    const raw = normalizeText(value);
    const compact = normalizePhone(raw);
    const digitsOnly = compact.replace(/\D/g, '');

    const variants = new Set([raw, compact, digitsOnly]);
    const addVariant = (candidate) => {
        if (candidate) variants.add(candidate);
    };

    if (digitsOnly.startsWith('84') && digitsOnly.length > 2) {
        addVariant(`0${digitsOnly.slice(2)}`);
    }

    if (digitsOnly.startsWith('0') && digitsOnly.length > 1) {
        addVariant(`+84${digitsOnly.slice(1)}`);
    }

    if (compact.startsWith('+84') && compact.length > 3) {
        addVariant(`0${compact.slice(3)}`);
    }

    if (compact.startsWith('84') && compact.length > 2) {
        addVariant(`0${compact.slice(2)}`);
    }

    if (compact.startsWith('0') && compact.length > 1) {
        addVariant(`+84${compact.slice(1)}`);
    }

    return [...variants].filter(Boolean);
};

const buildLoginLookup = (value) => {
    const identifier = normalizeText(value);
    if (!identifier) return null;

    return {
        identifier,
        emailRegex: identifier.includes('@') ? buildEmailRegex(identifier) : null,
        phoneVariants: identifier.includes('@') ? [] : buildPhoneVariants(identifier)
    };
};

const buildFrontendLoginUrl = () => {
    const configuredBaseUrl = process.env.FRONTEND_URL || process.env.FRONTEND_BASE_URL || 'https://busdn-se18c02.web.app';
    const baseUrl = /localhost|127\.0\.0\.1/i.test(configuredBaseUrl)
        ? 'https://busdn-se18c02.web.app'
        : configuredBaseUrl;

    const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
    return `${normalizedBaseUrl}/login`;
};

module.exports = {
    buildEmailRegex,
    buildFrontendLoginUrl,
    buildLoginLookup,
    buildPhoneVariants,
    normalizeEmail,
    normalizePhone,
    normalizeText
};
