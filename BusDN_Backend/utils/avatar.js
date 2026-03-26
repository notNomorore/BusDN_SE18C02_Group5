const DEFAULT_AVATAR_PATH = '/assets/default-avatar.svg';

const normalizeAvatarPath = (avatar) => {
    const value = String(avatar || '').trim();
    if (!value) return DEFAULT_AVATAR_PATH;

    if (
        value === '/images/default-avatar.png' ||
        value === '/images/default.png' ||
        value === '/images/default-avatar.svg'
    ) {
        return DEFAULT_AVATAR_PATH;
    }

    return value;
};

module.exports = {
    DEFAULT_AVATAR_PATH,
    normalizeAvatarPath
};
