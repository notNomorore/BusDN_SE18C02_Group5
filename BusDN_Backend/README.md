# BusDN Backend

## Latest Architecture (March 6, 2026)
- 4-step dynamic registration flow (Gmail style) with `express-session`:
  - `GET/POST /register-step1` - Identity (`fullName`)
  - `GET/POST /register-step2` - Single contact field (Email or Phone auto-detect)
  - `GET/POST /verify-otp` - Verification step for registration and forgot-password
  - `GET/POST /create-password` - Final account creation from `req.session.regData`
- Firebase Phone Auth integrated in step 2 with `recaptcha-container` and OTP verify.
- Registration session state stored in `req.session.regData`:
  - `fullName`, `contactType`, `contactValue`, `otpCode`, `otpExpires`, `phoneVerified`, `contactVerified`

## Priority and Admin Realtime
- Socket.io is enabled on server and emits pending-priority updates in realtime.
- Admin layout updates:
  - Top bar banner: `Co [X] ho so uu tien dang cho duyet`
  - Sidebar red exclamation badge on `Duyet ho so`
- Priority logic:
  - Approval expiry date must be at least 2 years from approval date.
  - Auto-expiry middleware runs pre-login/session request path and sets:
    - `isPriorityGroup = false`
    - `priorityStatus = EXPIRED`
- Rejection history is stored in `PriorityHistory` with:
  - `userId`, `profileId`, `rejectedBy`, `reason`, `timestamp`

## Discount Logic
- `applyPriorityDiscount(price, user)` is implemented in `utils/priorityUtils.js`.
- If `user.isPriorityGroup === true`, purchase flow applies fixed 20% discount.
- Monthly pass and wallet transaction store:
  - `originalPrice` / `originalAmount`
  - `discountAmount`
  - `pricePaid` final amount

## Main Files
- `Server.js` - Express + HTTP + Socket.io bootstrap
- `routes/webRoutes.js` - 4-step registration flow + OTP logic
- `controllers/priorityController.js` - approval/reject + realtime emit + email notify
- `controllers/monthlyPassController.js` - priority discount in purchase flow
- `middleware/priorityEnforcement.js` - auto-expire priority status
- `utils/priorityUtils.js` - discount + expiry + pending count emit
- `models/models.js` - `PriorityHistory`, `PhoneVerification`, priority fields

## Quick Start
```bash
cd BusDN_Backend
npm install
node Server.js
```

## Required ENV
- `MONGODB_URI`
- `SESSION_SECRET`
- `BACKEND_URL`
- `FRONTEND_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `EMAIL_USER`
- `EMAIL_PASS`
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_MEASUREMENT_ID`
- `VNPAY_MONTHLY_RETURN_URL` (recommended for monthly-pass flow)

## Registration URLs
- Step 1: `http://localhost:3000/register-step1`
- Step 2: `http://localhost:3000/register-step2`
- Step 3: `http://localhost:3000/verify-otp?type=registration`
- Step 4: `http://localhost:3000/create-password`
