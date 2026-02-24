const { User } = require('../models/models');

// Helper function to render admin views with layout
const renderAdmin = async (req, res, view, title, data = {}) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        const pageName = view.split('/').pop();

        const defaultData = {
            pendingCount: 0,
            stats: { pending: 0, approved: 0, rejected: 0 },
            query: {},
            users: [],
            profiles: [], // Thêm dòng này để fix lỗi profiles is not defined
            error: null,  // Thêm dòng này để fix lỗi error is not defined
            success: null, // Thêm luôn cho chắc
            page: 1,
            totalPages: 1,
            search: '',
            role: 'ALL'
        };

        res.render(view, { ...defaultData, ...data }, (err, html) => {
            if (err) {
                console.error('Error rendering view:', err);
                return res.status(500).send(`<h1>Lỗi hiển thị trang</h1><p>${err.message}</p>`);
            }
            res.render('admin/layout', {
                body: html,
                title: title,
                path: data.path || pageName, // Đồng bộ path ra layout
                user: currentUser
            });
        });
    } catch (e) {
        console.error('Error in renderAdmin:', e);
        res.redirect('/login');
    }
};

module.exports = { renderAdmin };
