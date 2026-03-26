const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

const uploadRoot = path.join(__dirname, '../public/uploads');
const priorityUploadRoot = path.join(uploadRoot, 'priority');

[uploadRoot, priorityUploadRoot].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// --- AVATAR UPLOAD STORAGE ---
const avatarStorage = multer.diskStorage({
    destination: uploadRoot,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const uniqueSuffix = crypto.randomUUID().replace(/-/g, '');
        cb(null, `avatar-${Date.now()}-${uniqueSuffix}${ext}`);
    }
});

// --- PRIORITY PROFILE UPLOAD STORAGE ---
const priorityStorage = multer.diskStorage({
    destination: priorityUploadRoot,
    filename: (req, file, cb) => {
        const userId = req.session?.userId || req.user?.userId || req.user?._id || 'unknown';
        const timestamp = Date.now();
        const ext = path.extname(file.originalname).toLowerCase();
        const fieldName = String(file.fieldname || 'file').toLowerCase();
        const uniqueSuffix = crypto.randomUUID().replace(/-/g, '');
        cb(null, `priority-${userId}-${fieldName}-${timestamp}-${uniqueSuffix}${ext}`);
    }
});

// --- FILE FILTER FOR IMAGES ---
const imageFileFilter = (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only image files are allowed (.jpg, .jpeg, .png)'), false);
    }
};

// --- MULTER INSTANCES ---
const upload = multer({ 
    storage: avatarStorage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const priorityProfileUpload = multer({
    storage: priorityStorage,
    fileFilter: imageFileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit for multiple files
});

module.exports = { 
    upload, 
    priorityProfileUpload 
};
