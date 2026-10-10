'use strict';

const crypto = require('node:crypto');

function allowedFrameOrigins(environment = process.env) {
  const origins = new Set();
  for (const value of String(environment.CORS_ALLOWED_ORIGINS || environment.FRONTEND_URL || '').split(',')) {
    try {
      const url = new URL(value.trim());
      if (!url.username && !url.password && (url.protocol === 'https:' || (environment.NODE_ENV !== 'production' && url.protocol === 'http:'))) {
        origins.add(url.origin);
      }
    } catch { /* malformed origins are never embedded in CSP or trusted by bridge */ }
  }
  return [...origins];
}

function captchaPage(req, res) {
  const key = String(process.env.RECAPTCHA_SITE_KEY || '').trim();
  if (key && key === String(process.env.RECAPTCHA_SECRET_KEY || '').trim()) {
    return res.status(503).json({ success: false, message: 'Mobile CAPTCHA requires a public site key that is different from the backend secret key.' });
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
    return res.status(503).json({ success: false, message: 'Mobile CAPTCHA has not been configured by your school.' });
  }
  const nonce = crypto.randomBytes(18).toString('base64');
  const frameOrigins = allowedFrameOrigins();
  res.set('Cache-Control', 'no-store');
  res.removeHeader('X-Frame-Options');
  res.set('Content-Security-Policy', [
    "default-src 'none'", `script-src 'nonce-${nonce}' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/`,
    "frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/",
    "connect-src https://www.google.com/recaptcha/", "style-src 'unsafe-inline'", "img-src data: https://www.gstatic.com",
    "base-uri 'none'", "form-action 'none'", `frame-ancestors 'self' ${frameOrigins.join(' ')}`,
  ].join('; '));
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EduMatch account verification</title><style>body{font:16px system-ui;background:#f8fafc;color:#102a43;display:flex;min-height:85vh;align-items:center;justify-content:center;margin:0}main{text-align:center;padding:20px}#captcha{display:inline-block}p{max-width:330px;line-height:1.5}</style></head><body><main><h2>Verify your sign in</h2><p>Complete the security check to continue to EduMatch.</p><div id="captcha"></div><p id="status" role="status"></p></main><script nonce="${nonce}">var trustedOrigins=${JSON.stringify(frameOrigins)};function send(type,token){var payload={type:type,token:token||''};if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(payload));}if(window.parent!==window){try{var parentOrigin=new URL(document.referrer).origin;if(trustedOrigins.indexOf(parentOrigin)!==-1||parentOrigin===window.location.origin){window.parent.postMessage(payload,parentOrigin);}}catch(error){}}}window.ready=function(){grecaptcha.render('captcha',{sitekey:${JSON.stringify(key)},callback:function(token){document.getElementById('status').textContent='Verified. Returning to EduMatch…';send('captcha',token);},'expired-callback':function(){send('expired');},'error-callback':function(){document.getElementById('status').textContent='Verification unavailable. Try again.';send('error');}})};</script><script nonce="${nonce}" src="https://www.google.com/recaptcha/api.js?onload=ready&amp;render=explicit" async defer></script></body></html>`);
}

module.exports = { captchaPage, allowedFrameOrigins };
