const multer = require('multer');
const path = require('path');

// --- AVATAR UPLOAD STORAGE ---
const avatarStorage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, 'avatar-' + Date.now() + path.extname(file.originalname));
    }
});

// --- PRIORITY PROFILE UPLOAD STORAGE ---
const priorityStorage = multer.diskStorage({
    destination: './public/uploads/priority/',
    filename: (req, file, cb) => {
        const userId = req.session?.userId || req.user?.userId || req.user?._id || 'unknown';
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `priority-${userId}-${timestamp}${ext}`);
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
