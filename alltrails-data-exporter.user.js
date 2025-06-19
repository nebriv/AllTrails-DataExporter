// ==UserScript==
// @name         AllTrails Data Exporter
// @namespace    https://github.com/nebriv/AllTrails-DataExporter
// @version      5.0.0
// @description  Bulk exporter for AllTrails GPX files with anti-bot protection and rate limit handling
// @author       nebriv
// @match        https://www.alltrails.com/*
// @grant        GM_download
// @grant        GM_openInTab
// @license      MIT
// @homepage     https://github.com/nebriv/AllTrails-DataExporter
// @supportURL   https://github.com/nebriv/AllTrails-DataExporter/issues
// @updateURL    https://github.com/nebriv/AllTrails-DataExporter/raw/main/alltrails-bulk-downloader.user.js
// @downloadURL  https://github.com/nebriv/AllTrails-DataExporter/raw/main/alltrails-bulk-downloader.user.js
// ==/UserScript==

/*
 * ====================================================================
 * AllTrails Data Exporter v5.0.0
 * ====================================================================
 * 
 * A userscript for bulk downloading GPX files from AllTrails
 * with anti-bot protection and rate limit handling.
 * 
 * FEATURES:
 * - Bulk GPX download from your AllTrails recordings
 * - Optional JSON metadata extraction (trail info, stats, photos, etc.)
 * - Human-like behavior simulation (randomized delays, realistic clicks)
 * - CAPTCHA detection and automatic handling
 * - Rate limit detection with smart retry logic
 * - URL discovery from your recordings page
 * - Import/export URL lists
 * - Progress tracking and recovery
 * - Detailed logging and error handling
 * 
 * HOW TO USE:
 * 1. Install this userscript in Tampermonkey/Greasemonkey
 * 2. Navigate to https://www.alltrails.com/members/your-username/recordings
 * 3. Use the floating control panel (top-left):
 *    - Click "1. Discover URLs" to find all your recordings
 *    - Click "2. Download GPX+JSON" to start bulk download
 *    - Or use the import button to load a list of URLs directly
 * 
 * CONFIGURATION:
 * - Toggle "Human-like behavior" for anti-bot protection (recommended)
 * - Toggle "Save review data as JSON" to export metadata
 * - Adjust delays in CONFIG section if needed
 * 
 * TROUBLESHOOTING:
 * - If rate limited: Script will automatically skip to next file and retry later
 * - If CAPTCHA appears: Complete it manually, then click "Resume"
 * - If stuck: Use the "Recover" button or refresh the page
 * 
 * GITHUB: https://github.com/nebriv/AllTrails-DataExporter
 * 
 * ====================================================================
 */

(function() {
    'use strict';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================

    const VERSION = '5.0.0';
    const SCRIPT_NAME = 'AllTrails GPX Bulk Downloader';

    // Download timing configuration (in milliseconds)
    const CONFIG = {
        // Delays between downloads (randomized within range)
        downloadDelay: {
            min: 90000,    // 1.5 minutes minimum
            max: 185000    // ~3 minutes maximum
        },
        
        // Delays between page actions
        scrollDelay: {
            min: 1500,     // 1.5-2.5 seconds between scrolls
            max: 2500
        },
        
        clickDelay: {
            min: 1000,     // 1-4.5 seconds between clicks
            max: 4500
        },
        
        pageLoadWait: {
            min: 2000,     // 2-5 seconds to wait for page load
            max: 5000
        },
        
        // Rate limiting configuration
        rateLimitRetryDelay: {
            min: 90000,    // 1.5-3 minutes for rate limit backoff
            max: 180000
        },
        
        // Process timeouts and limits
        maxScrollAttempts: 100,      // Max scrolls during URL discovery
        stuckTimeout: 300000,        // 5 minutes before considering process stuck
        processTimeout: 90000,       // 1.5 minutes per download attempt
        heartbeatInterval: 30000,    // 30 seconds between heartbeats
        captchaCheckInterval: 2000,  // Check for CAPTCHA every 2 seconds
        captchaAutoRetryDelay: 60000, // Wait 1 minute before auto-retry after CAPTCHA
        
        // Feature toggles
        saveReviewData: true,        // Save JSON metadata by default
        humanLikeBehavior: true,     // Enable anti-bot protection by default
        debugMode: true,             // Enable debug logging
        autoRestart: true,           // Auto-recover from stuck processes
        
        // Adaptive behavior
        adaptiveDelays: false,       // Increase delays after rate limiting
        rateLimitDetected: false     // Track if we've hit rate limits
    };

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    // Enhanced logging with timestamps
    function log(message, level = 'INFO') {
        const timestamp = new Date().toISOString().substr(11, 8);
        const prefix = `[${SCRIPT_NAME} ${timestamp}]`;
        
        switch(level) {
            case 'ERROR':
                console.error(`${prefix} ERROR: ${message}`);
                break;
            case 'WARN':
                console.warn(`${prefix} WARNING: ${message}`);
                break;
            case 'SUCCESS':
                console.log(`${prefix} SUCCESS: ${message}`);
                break;
            default:
                console.log(`${prefix} ${message}`);
        }
    }

    // Sleep utility with logging
    function sleep(ms) {
        if (CONFIG.debugMode && ms > 5000) {
            log(`Sleeping for ${Math.round(ms/1000)}s`);
        }
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Random number utilities
    const RND = {
        int: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
        float: (min, max) => Math.random() * (max - min) + min,
        delay: (configKey) => {
            const range = CONFIG[configKey];
            return RND.int(range.min, range.max);
        },
        choice: (arr) => arr[Math.floor(Math.random() * arr.length)],
        bool: (probability = 0.5) => Math.random() < probability,
        scrollAmount: (base = 3000) => base + RND.int(-800, 800),
        clickOffset: () => ({ x: RND.int(-5, 5), y: RND.int(-5, 5) })
    };

    // Enhanced random delay with interaction simulation
    async function randomDelay(configKey, customMin = null, customMax = null) {
        let delayMs;

        if (customMin !== null && customMax !== null) {
            delayMs = RND.int(customMin, customMax);
        } else if (CONFIG[configKey]) {
            delayMs = RND.delay(configKey);
        } else {
            delayMs = RND.int(1000, 3000);
        }

        if (CONFIG.debugMode && delayMs > 5000) {
            log(`Random delay: ${Math.round(delayMs/1000)}s (${configKey})`);
        }
        
        await sleep(delayMs);

        // Occasionally add human-like interactions during long delays
        if (delayMs > 2000 && RND.bool(0.4)) {
            await HumanBehavior.randomInteraction();
        }
    }

    // ============================================================================
    // STATE MANAGEMENT
    // ============================================================================

    const state = {
        get: (key) => {
            try {
                const value = sessionStorage.getItem(`alltrails_v5_${key}`);
                return JSON.parse(value || 'null');
            } catch (e) {
                log(`Error getting state ${key}: ${e.message}`, 'ERROR');
                return null;
            }
        },
        
        set: (key, value) => {
            try {
                sessionStorage.setItem(`alltrails_v5_${key}`, JSON.stringify(value));
                sessionStorage.setItem(`alltrails_v5_lastHeartbeat`, Date.now());
                
                // Trigger UI update after state change
                setTimeout(() => updateUI(), 100);
            } catch (e) {
                log(`Error setting state ${key}: ${e.message}`, 'ERROR');
            }
        },
        
        clear: () => {
            Object.keys(sessionStorage).forEach(key => {
                if (key.startsWith('alltrails_v5_')) {
                    sessionStorage.removeItem(key);
                }
            });
            log('State cleared');
        },
        
        removeProcessedUrl: (url) => {
            const pendingUrls = state.get('pendingUrls') || [];
            const processedUrls = state.get('processedUrls') || [];

            const updatedPending = pendingUrls.filter(u => u !== url);
            processedUrls.push({
                url: url,
                timestamp: Date.now(),
                status: 'processed'
            });

            state.set('pendingUrls', updatedPending);
            state.set('processedUrls', processedUrls);

            log(`URL processed. Remaining: ${updatedPending.length}`);
        }
    };

    // Mode management
    function getCurrentMode() {
        return state.get('mode') || 'idle';
    }

    function setMode(mode, data = {}) {
        state.set('mode', mode);
        state.set('modeData', data);
        state.set('lastActivity', Date.now());
        state.set('lastModeChange', Date.now());
        log(`Mode changed to: ${mode}`);
    }

    // ============================================================================
    // HUMAN BEHAVIOR SIMULATION
    // ============================================================================

    const HumanBehavior = {
        // Simulate human-like clicking with visual feedback
        async humanClick(element) {
            if (!CONFIG.humanLikeBehavior || !element) {
                if (element) element.click();
                return;
            }

            try {
                // Visual feedback - slightly scale down element
                const originalStyle = element.style.cssText;
                element.style.transform = 'scale(0.98)';
                element.style.transition = 'transform 0.1s';

                await sleep(RND.int(50, 200));

                // Calculate realistic click coordinates
                const rect = element.getBoundingClientRect();
                const clickX = rect.left + rect.width * RND.float(0.2, 0.8);
                const clickY = rect.top + rect.height * RND.float(0.2, 0.8);

                // Simulate mouse events in sequence
                const events = ['mousedown', 'mouseup', 'click'];
                for (const eventType of events) {
                    const event = new MouseEvent(eventType, {
                        bubbles: true,
                        cancelable: true,
                        clientX: clickX,
                        clientY: clickY,
                        button: 0
                    });
                    element.dispatchEvent(event);

                    if (eventType !== 'click') await sleep(RND.int(10, 50));
                }

                // Restore original styling
                setTimeout(() => {
                    element.style.cssText = originalStyle;
                }, 100);

                if (CONFIG.debugMode) {
                    log(`Human-like click at (${Math.round(clickX)}, ${Math.round(clickY)})`);
                }

            } catch (error) {
                log(`Click simulation failed, using fallback: ${error.message}`, 'WARN');
                element.click();
            }
        },

        // Simulate reading/thinking time
        async simulateReading() {
            if (!CONFIG.humanLikeBehavior) return;

            const readingTime = RND.int(800, 2500);
            if (CONFIG.debugMode) {
                log(`Simulating reading for ${readingTime}ms`);
            }
            await sleep(readingTime);
        },

        // Random mouse movements
        async randomMouseMovement() {
            if (!CONFIG.humanLikeBehavior) return;

            try {
                const event = new MouseEvent('mousemove', {
                    clientX: RND.int(100, window.innerWidth - 100),
                    clientY: RND.int(100, window.innerHeight - 100),
                    bubbles: true
                });
                document.dispatchEvent(event);
            } catch (error) {
                // Ignore mouse movement errors
            }
        },

        // Human-like scrolling in chunks
        async humanScroll(targetAmount) {
            if (!CONFIG.humanLikeBehavior) {
                window.scrollBy(0, targetAmount);
                return;
            }

            const chunks = RND.int(2, 4);
            const chunkSize = Math.floor(targetAmount / chunks);

            for (let i = 0; i < chunks; i++) {
                const scrollAmount = i === chunks - 1 ?
                    targetAmount - (chunkSize * (chunks - 1)) :
                    chunkSize + RND.int(-100, 100);

                window.scrollBy(0, scrollAmount);
                await sleep(RND.int(200, 600));
            }

            if (CONFIG.debugMode) {
                log(`Human-like scroll: ${targetAmount}px in ${chunks} chunks`);
            }
        },

        // Random interactions during delays
        async randomInteraction() {
            if (!CONFIG.humanLikeBehavior || !RND.bool(0.3)) return;

            const actions = [
                () => this.randomMouseMovement(),
                () => sleep(RND.int(500, 1500)),
                () => window.scrollBy(0, RND.int(-200, 200))
            ];

            const action = RND.choice(actions);
            await action();
        }
    };

    // ============================================================================
    // CAPTCHA AND RATE LIMIT DETECTION
    // ============================================================================

    const ProtectionDetector = {
        // Main detection function
        detectProtection() {
            // Check for rate limiting first (higher priority)
            const rateLimitInfo = this.detectRateLimit();
            if (rateLimitInfo.detected) {
                return rateLimitInfo;
            }

            // Then check for CAPTCHA if on a suspicious page
            if (!this.isNormalAllTrailsPage()) {
                const captchaInfo = this.detectCaptcha();
                if (captchaInfo.detected) {
                    return captchaInfo;
                }
            }

            return { detected: false };
        },

        // Detect rate limiting messages and error pages
        detectRateLimit() {
            const bodyText = (document.body?.textContent || '').toLowerCase();
            const title = document.title.toLowerCase();

            const rateLimitPhrases = [
                'you are not permitted to download this file',
                'please try again later',
                'too many requests',
                'rate limit exceeded',
                'slow down',
                'access temporarily restricted',
                'an error has occurred'
            ];

            const hasRateLimitText = rateLimitPhrases.some(phrase => bodyText.includes(phrase));
            const hasErrorTitle = title.includes('error') || title.includes('access denied');
            const hasErrorElement = document.querySelector('.dialog, .error, [class*="error"]');

            if (hasRateLimitText && (hasErrorTitle || hasErrorElement)) {
                return {
                    detected: true,
                    type: 'rate_limit',
                    isRateLimit: true,
                    element: hasErrorElement
                };
            }

            return { detected: false };
        },

        // Detect CAPTCHA elements and pages
        detectCaptcha() {
            // Look for CAPTCHA-specific selectors
            const captchaSelectors = [
                '#captcha-container[data-dd-captcha-container]',
                '.captcha[data-dd-captcha-container]',
                'iframe[src*="captcha"]',
                'iframe[src*="recaptcha"]',
                '.g-recaptcha[data-sitekey]',
                '.h-captcha[data-hcaptcha-sitekey]',
                '[data-dd-captcha-header]'
            ];

            for (const selector of captchaSelectors) {
                const element = document.querySelector(selector);
                if (element && this.validateCaptchaElement(element)) {
                    return {
                        detected: true,
                        type: this.identifyCaptchaType(selector),
                        isCaptcha: true,
                        element: element
                    };
                }
            }

            // Check for CAPTCHA pages
            if (this.isCaptchaPage()) {
                return {
                    detected: true,
                    type: 'page-based',
                    isCaptcha: true,
                    element: null
                };
            }

            return { detected: false };
        },

        // Check if we're on a normal AllTrails page
        isNormalAllTrailsPage() {
            const url = window.location.href;
            const normalPaths = [
                '/members/',
                '/explore/trail/',
                '/explore/recording/',
                '/trail/',
                '/search'
            ];

            const hasNormalPath = normalPaths.some(path => url.includes(path));
            const hasAllTrailsLogo = document.querySelector('a[href="/"]') ||
                                   document.querySelector('[alt*="AllTrails"]') ||
                                   document.querySelector('header');

            return hasNormalPath && hasAllTrailsLogo;
        },

        // Validate CAPTCHA elements
        validateCaptchaElement(element) {
            const rect = element.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0;

            const hasCaptchaAttributes = element.hasAttribute('data-dd-captcha-container') ||
                                       element.hasAttribute('data-sitekey') ||
                                       element.hasAttribute('data-hcaptcha-sitekey');

            const hasCaptchaText = element.textContent.toLowerCase().includes('verification') ||
                                 element.textContent.toLowerCase().includes('captcha') ||
                                 element.textContent.toLowerCase().includes('prove you are human');

            return isVisible && (hasCaptchaAttributes || hasCaptchaText);
        },

        // Check for CAPTCHA page indicators
        isCaptchaPage() {
            const title = document.title.toLowerCase();
            const hasVerificationTitle = title.includes('verification') ||
                                       title.includes('captcha') ||
                                       title.includes('security check');

            const captchaPageTexts = [
                'verification required',
                'prove you are not a robot',
                'complete the captcha below',
                'security verification',
                'unusual activity from your device'
            ];

            const bodyText = (document.body?.textContent || '').toLowerCase();
            const hasCaptchaPageText = captchaPageTexts.some(text => bodyText.includes(text));
            const hasMinimalContent = document.querySelectorAll('a, button, input').length < 10;

            return hasVerificationTitle && hasCaptchaPageText && hasMinimalContent;
        },

        // Identify CAPTCHA type
        identifyCaptchaType(selector) {
            if (selector.includes('recaptcha') || selector.includes('g-recaptcha')) {
                return 'reCAPTCHA';
            } else if (selector.includes('hcaptcha') || selector.includes('h-captcha')) {
                return 'hCaptcha';
            } else if (selector.includes('dd-captcha') || selector.includes('captcha-delivery')) {
                return 'DataDome';
            } else {
                return 'Generic';
            }
        },

        // Handle detected protection
        async handleProtectionDetected(protectionInfo) {
            if (protectionInfo.isRateLimit) {
                await this.handleRateLimit(protectionInfo);
            } else if (protectionInfo.isCaptcha) {
                await this.handleCaptcha(protectionInfo);
            }
        },

        // Handle rate limiting
        async handleRateLimit(rateLimitInfo) {
            log('Rate limit detected - implementing smart retry strategy', 'WARN');

            // Enable adaptive delays
            CONFIG.adaptiveDelays = true;
            CONFIG.rateLimitDetected = true;
            this.increaseDelays();

            // Move current URL to end of queue
            const pendingUrls = state.get('pendingUrls') || [];
            if (pendingUrls.length > 0) {
                const currentUrl = pendingUrls[0];
                const rateLimitedUrls = state.get('rateLimitedUrls') || [];
                
                rateLimitedUrls.push({
                    url: currentUrl,
                    timestamp: Date.now(),
                    retryAfter: Date.now() + RND.delay('rateLimitRetryDelay'),
                    attempts: (rateLimitedUrls.filter(u => u.url === currentUrl).length) + 1
                });
                
                const updatedPending = pendingUrls.slice(1);
                const currentAttempts = rateLimitedUrls.filter(u => u.url === currentUrl).length;
                
                if (currentAttempts < 3) {
                    updatedPending.push(currentUrl);
                    log(`URL moved to end of queue for later retry (attempt ${currentAttempts}/3)`);
                } else {
                    log(`URL permanently failed after 3 rate limit attempts`, 'ERROR');
                    const failedCount = state.get('failedCount') || 0;
                    state.set('failedCount', failedCount + 1);
                }
                
                state.set('pendingUrls', updatedPending);
                state.set('rateLimitedUrls', rateLimitedUrls);
                
                this.showRateLimitNotification(rateLimitInfo, updatedPending);
                this.logRateLimitDetails(rateLimitInfo, updatedPending);
                
                setMode('rate_limit_backoff');
                
                setTimeout(() => {
                    this.moveToNextAfterRateLimit(updatedPending);
                }, 3000);
            } else {
                log('No more URLs to process', 'WARN');
                finishDownload();
            }
        },

        // Handle CAPTCHA detection
        async handleCaptcha(captchaInfo) {
            log(`CAPTCHA detected: ${captchaInfo.type}`, 'WARN');

            this.pauseAllOperations();
            this.showCaptchaNotification(captchaInfo);
            this.logCaptchaDetails(captchaInfo);

            state.set('captchaDetected', {
                timestamp: Date.now(),
                type: captchaInfo.type,
                url: window.location.href,
                previousMode: getCurrentMode()
            });

            setMode('captcha_paused');
        },

        // Increase delays after rate limiting
        increaseDelays() {
            const multiplier = 1.5;

            CONFIG.downloadDelay.min = Math.round(CONFIG.downloadDelay.min * multiplier);
            CONFIG.downloadDelay.max = Math.round(CONFIG.downloadDelay.max * multiplier);
            CONFIG.clickDelay.min = Math.round(CONFIG.clickDelay.min * multiplier);
            CONFIG.clickDelay.max = Math.round(CONFIG.clickDelay.max * multiplier);

            log(`Delays increased by 50%: Download ${CONFIG.downloadDelay.min/1000}-${CONFIG.downloadDelay.max/1000}s, Click ${CONFIG.clickDelay.min/1000}-${CONFIG.clickDelay.max/1000}s`, 'WARN');
        },

        // Move to next URL after rate limit
        moveToNextAfterRateLimit(updatedPending) {
            if (updatedPending.length > 0) {
                const nextUrl = updatedPending[0];
                log(`Moving to next URL after rate limit: ${nextUrl.split('/').pop()}`);
                setMode('downloading');
                window.location.href = nextUrl;
            } else {
                log('No more URLs to process after rate limit');
                finishDownload();
            }
        },

        // Pause all operations
        pauseAllOperations() {
            clearTimeout(window.allTrailsDownloadTimeout);
            clearTimeout(window.allTrailsScrollTimeout);

            const currentMode = getCurrentMode();
            log(`Pausing operations from mode: ${currentMode}`);

            state.set('pausedFromMode', currentMode);
            state.set('pausedAt', Date.now());
        },

        // Show rate limit notification
        showRateLimitNotification(rateLimitInfo, updatedPending) {
            const existingNotification = document.getElementById('rate-limit-notification');
            if (existingNotification) {
                existingNotification.remove();
            }

            const notification = document.createElement('div');
            notification.id = 'rate-limit-notification';
            notification.style.cssText = `
                position: fixed; top: 20px; left: 20px; background: #ff9800; color: white;
                padding: 15px; border-radius: 10px; z-index: 50000; font-family: Arial, sans-serif;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 350px; border: 3px solid #f57c00;
                cursor: move;
            `;

            const rateLimitedUrls = state.get('rateLimitedUrls') || [];
            const currentUrlAttempts = rateLimitedUrls.filter(u => u.url === window.location.href).length;
            const nextUrl = updatedPending.length > 0 ? updatedPending[0] : null;

            notification.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <h3 style="margin: 0; font-size: 14px;">RATE LIMIT DETECTED</h3>
                    <button id="close-rate-limit-notification" style="background: none; border: 1px solid white; color: white; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 12px;">×</button>
                </div>
                <p style="margin: 8px 0; font-size: 12px;">AllTrails is asking us to slow down.</p>
                <p style="margin: 8px 0; font-size: 11px;">
                    <strong>Action:</strong> Moving to next file now<br>
                    <strong>Current file:</strong> Moved to end of queue (attempt ${currentUrlAttempts}/3)<br>
                    <strong>Next file:</strong> ${nextUrl ? nextUrl.split('/').pop().substr(0, 15) + '...' : 'None (finishing)'}<br>
                    <strong>Remaining:</strong> ${updatedPending.length} files<br>
                    <strong>Delays:</strong> Increased by 50% for future downloads
                </p>
                <div style="margin: 12px 0;">
                    <div style="background: rgba(255,255,255,0.2); border-radius: 5px; padding: 5px; font-size: 10px;">
                        Moving to next file in 3 seconds...<br>
                        Rate-limited file will be retried later
                    </div>
                </div>
            `;

            document.body.appendChild(notification);

            document.getElementById('close-rate-limit-notification').onclick = () => {
                notification.remove();
            };

            this.makeDraggable(notification);

            setTimeout(() => {
                if (document.getElementById('rate-limit-notification')) {
                    notification.remove();
                }
            }, 10000);
        },

        // Show CAPTCHA notification
        showCaptchaNotification(captchaInfo) {
            const existingNotification = document.getElementById('captcha-notification');
            if (existingNotification) {
                existingNotification.remove();
            }

            const notification = document.createElement('div');
            notification.id = 'captcha-notification';
            notification.style.cssText = `
                position: fixed; top: 20px; left: 20px; background: #ff4444; color: white;
                padding: 15px; border-radius: 10px; z-index: 50000; font-family: Arial, sans-serif;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5); max-width: 350px; border: 3px solid #cc0000;
                cursor: move;
            `;

            let isMinimized = false;

            const updateNotificationContent = () => {
                notification.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: ${isMinimized ? '0' : '10px'};">
                        <h3 style="margin: 0; font-size: 14px;">CAPTCHA DETECTED</h3>
                        <div>
                            <button id="minimize-notification" style="background: none; border: 1px solid white; color: white; border-radius: 3px; padding: 2px 6px; cursor: pointer; margin-right: 5px; font-size: 12px;">
                                ${isMinimized ? '+' : '−'}
                            </button>
                            <button id="close-notification" style="background: none; border: 1px solid white; color: white; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 12px;">×</button>
                        </div>
                    </div>
                    ${!isMinimized ? `
                        <p style="margin: 8px 0; font-size: 12px;"><strong>Type:</strong> ${captchaInfo.type}</p>
                        <p style="margin: 8px 0; font-size: 11px;">Script <strong>PAUSED</strong> - Complete CAPTCHA manually, then click Resume.</p>
                        <div style="margin: 12px 0;">
                            <button id="resume-after-captcha" style="background: #4CAF50; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; margin: 3px; font-size: 12px;">Resume</button>
                            <button id="stop-after-captcha" style="background: #666; color: white; border: none; padding: 8px 15px; border-radius: 5px; cursor: pointer; margin: 3px; font-size: 12px;">Stop</button>
                        </div>
                        <p style="margin: 8px 0 0 0; font-size: 10px; opacity: 0.8;">Auto-retry in ${Math.ceil(CONFIG.captchaAutoRetryDelay/1000)}s...</p>
                    ` : ''}
                `;

                const resumeBtn = document.getElementById('resume-after-captcha');
                const stopBtn = document.getElementById('stop-after-captcha');
                const minimizeBtn = document.getElementById('minimize-notification');
                const closeBtn = document.getElementById('close-notification');

                if (resumeBtn) resumeBtn.onclick = () => { this.resumeAfterCaptcha(); notification.remove(); };
                if (stopBtn) stopBtn.onclick = () => { stopAll(); notification.remove(); };
                if (minimizeBtn) minimizeBtn.onclick = () => { isMinimized = !isMinimized; updateNotificationContent(); };
                if (closeBtn) closeBtn.onclick = () => notification.style.display = 'none';
            };

            updateNotificationContent();
            document.body.appendChild(notification);
            this.makeDraggable(notification);

            setTimeout(() => {
                if (document.getElementById('captcha-notification')) {
                    log('Auto-retrying after CAPTCHA delay...');
                    this.resumeAfterCaptcha();
                    notification.remove();
                }
            }, CONFIG.captchaAutoRetryDelay);
        },

        // Make element draggable
        makeDraggable(element) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

            element.onmousedown = dragMouseDown;

            function dragMouseDown(e) {
                e = e || window.event;
                e.preventDefault();
                pos3 = e.clientX;
                pos4 = e.clientY;
                document.onmouseup = closeDragElement;
                document.onmousemove = elementDrag;
            }

            function elementDrag(e) {
                e = e || window.event;
                e.preventDefault();
                pos1 = pos3 - e.clientX;
                pos2 = pos4 - e.clientY;
                pos3 = e.clientX;
                pos4 = e.clientY;

                const newTop = element.offsetTop - pos2;
                const newLeft = element.offsetLeft - pos1;
                const maxLeft = window.innerWidth - element.offsetWidth;
                const maxTop = window.innerHeight - element.offsetHeight;

                element.style.top = Math.max(0, Math.min(newTop, maxTop)) + "px";
                element.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + "px";
            }

            function closeDragElement() {
                document.onmouseup = null;
                document.onmousemove = null;
            }
        },

        // Log rate limit details
        logRateLimitDetails(rateLimitInfo, updatedPending) {
            const rateLimitedUrls = state.get('rateLimitedUrls') || [];
            const currentUrl = window.location.href;
            const currentAttempts = rateLimitedUrls.filter(u => u.url === currentUrl).length;
            
            log(`Rate Limit Details:`, 'WARN');
            log(`- URL: ${currentUrl}`);
            log(`- Attempt #: ${currentAttempts}/3 for this URL`);
            log(`- Action: Moving current file to end of queue`);
            log(`- Remaining URLs in queue: ${updatedPending.length}`);
            log(`- Next URL: ${updatedPending.length > 0 ? updatedPending[0].split('/').pop() : 'None (finishing)'}`);
            log(`- New Download Delays: ${CONFIG.downloadDelay.min/1000}-${CONFIG.downloadDelay.max/1000}s`);
            log(`- Timestamp: ${new Date().toISOString()}`);
        },

        // Log CAPTCHA details
        logCaptchaDetails(captchaInfo) {
            log(`CAPTCHA Details:`, 'WARN');
            log(`- Type: ${captchaInfo.type}`);
            log(`- URL: ${window.location.href}`);
            log(`- User Agent: ${navigator.userAgent}`);
            log(`- Timestamp: ${new Date().toISOString()}`);

            if (captchaInfo.element) {
                log(`- Element: ${captchaInfo.element.tagName} ${captchaInfo.element.className}`);
            }

            const currentMode = getCurrentMode();
            const pendingUrls = state.get('pendingUrls') || [];
            log(`- Current Mode: ${currentMode}`);
            log(`- Pending URLs: ${pendingUrls.length}`);
        },

        // Resume after CAPTCHA
        resumeAfterCaptcha() {
            log('Attempting to resume after CAPTCHA...');

            const captchaCheck = this.detectProtection();
            if (captchaCheck.detected && captchaCheck.isCaptcha) {
                log('CAPTCHA still present, cannot resume', 'WARN');
                alert('CAPTCHA is still visible. Please complete it first.');
                return;
            }

            state.set('captchaDetected', null);
            const pausedFromMode = state.get('pausedFromMode') || 'idle';
            log(`Resuming from previous mode: ${pausedFromMode}`);

            if (pausedFromMode === 'downloading') {
                setMode('downloading');
                log('Resuming download process...');
                setTimeout(() => location.reload(), 2000);
            } else if (pausedFromMode === 'discovering') {
                setMode('discovering');
                log('Resuming discovery process...');
                setTimeout(() => location.reload(), 2000);
            } else {
                setMode('idle');
                log('Returning to idle mode');
                setTimeout(() => location.reload(), 1000);
            }
        },

        // Start protection monitoring
        startMonitoring() {
            log('Starting CAPTCHA and rate limit monitoring...');

            setInterval(() => {
                const currentMode = getCurrentMode();
                if (currentMode !== 'captcha_paused' && currentMode !== 'rate_limit_backoff') {
                    const detectionResult = this.detectProtection();
                    if (detectionResult.detected) {
                        this.handleProtectionDetected(detectionResult);
                    }
                }
            }, CONFIG.captchaCheckInterval);

            setTimeout(() => {
                const detectionResult = this.detectProtection();
                if (detectionResult.detected) {
                    this.handleProtectionDetected(detectionResult);
                }
            }, 1000);
        }
    };

    // ============================================================================
    // DATA EXTRACTION
    // ============================================================================

    // Extract comprehensive review and trail data
    function extractReviewData() {
        try {
            const data = {
                extractedAt: new Date().toISOString(),
                url: window.location.href,
                activityId: window.location.pathname.split('/').pop(),
                trail: {},
                activity: {},
                review: {},
                stats: {},
                photos: []
            };

            // Extract trail information with multiple selector fallbacks
            const trailSelectors = [
                '[data-testid*="TrailCard_"] [data-testid*="_Title"]',
                '.styles-module__reviews2TrackName___J0NYI',
                'h1',
                '.trail-name',
                '[class*="trail-title"]'
            ];

            for (const selector of trailSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim()) {
                    data.trail.name = element.textContent.trim();
                    break;
                }
            }

            // Extract linked trail information
            const linkedTrailElement = document.querySelector('a[href*="/trail/"]');
            if (linkedTrailElement) {
                data.trail.linkedTrailUrl = linkedTrailElement.href;
                data.trail.linkedTrailName = linkedTrailElement.textContent.trim();
            }

            // Extract difficulty, rating, location with fallbacks
            const extractWithFallbacks = (selectors, key) => {
                for (const selector of selectors) {
                    const element = document.querySelector(selector);
                    if (element && element.textContent.trim()) {
                        data.trail[key] = element.textContent.trim();
                        break;
                    }
                }
            };

            extractWithFallbacks([
                '[data-testid*="_Difficulty"]',
                '.difficulty',
                '[class*="difficulty"]'
            ], 'difficulty');

            extractWithFallbacks([
                '[data-testid*="_Rating"]',
                '.rating',
                '[class*="rating"]'
            ], 'rating');

            extractWithFallbacks([
                '[data-testid*="_Location"]',
                '.location',
                '[class*="location"]'
            ], 'location');

            // Extract activity date and type
            const dateActivityElement = document.querySelector('.styles-module__dateAndActivity___HyeGo');
            if (dateActivityElement) {
                const text = dateActivityElement.textContent.trim();
                const parts = text.split('•').map(p => p.trim());
                if (parts.length >= 2) {
                    data.activity.date = parts[0];
                    data.activity.type = parts[1];
                }
            }

            // Extract review rating
            const ratingInputs = document.querySelectorAll('input[name="rating"]:checked');
            if (ratingInputs.length > 0) {
                data.review.rating = parseInt(ratingInputs[0].value);
            } else {
                const filledStars = document.querySelectorAll('.MuiRating-iconFilled');
                data.review.rating = filledStars.length;
            }

            // Extract review comment
            const commentSelectors = [
                '.styles-module__reviewComment___WNT3m',
                '.review-comment',
                '[class*="comment"]'
            ];

            for (const selector of commentSelectors) {
                const element = document.querySelector(selector);
                if (element && element.textContent.trim()) {
                    data.review.comment = element.textContent.trim();
                    break;
                }
            }

            // Extract privacy setting
            const privacyElement = document.querySelector('.styles-module__privacyDropdown___mEaGT button');
            if (privacyElement) {
                data.review.privacy = privacyElement.textContent.trim();
            }

            // Extract comprehensive stats
            const statsContainer = document.querySelector('.styles-module__statsContainer___pHGmd');
            if (statsContainer) {
                const statSections = statsContainer.querySelectorAll('.styles-module__section___nefNN');
                statSections.forEach(section => {
                    const label = section.querySelector('.styles-module__label___xz5xq');
                    const value = section.querySelector('.styles-module__dataSection___zgMoI');
                    if (label && value) {
                        const key = label.textContent.trim().toLowerCase().replace(/[.\s]/g, '_');
                        data.stats[key] = value.textContent.trim();
                    }
                });
            }

            // Extract photos
            const photoElements = document.querySelectorAll('.styles-module__uploadedPhoto___GGxFg img');
            data.photos = Array.from(photoElements).map((img, index) => ({
                index: index + 1,
                src: img.src,
                alt: img.alt || '',
                filename: img.src.split('/').pop()
            }));

            // Extract notes
            const notesTextarea = document.querySelector('[data-testid="notesTextArea"]');
            if (notesTextarea && notesTextarea.value.trim()) {
                data.review.notes = notesTextarea.value.trim();
            }

            // Clean up empty objects
            Object.keys(data).forEach(key => {
                if (typeof data[key] === 'object' && Object.keys(data[key]).length === 0) {
                    delete data[key];
                }
            });

            log(`Extracted review data: ${data.trail.name || 'Unknown trail'} - Rating: ${data.review.rating || 'N/A'}`, 'SUCCESS');
            return data;

        } catch (error) {
            log(`Error extracting review data: ${error.message}`, 'ERROR');
            return {
                extractedAt: new Date().toISOString(),
                url: window.location.href,
                error: error.message
            };
        }
    }

    // Save review data as JSON file
    function saveReviewDataAsJson(reviewData) {
        try {
            const jsonString = JSON.stringify(reviewData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const activityId = reviewData.activityId || 'unknown';
            const trailName = (reviewData.trail?.name || 'unknown_trail')
                .replace(/[^a-zA-Z0-9\s-]/g, '')
                .replace(/\s+/g, '_')
                .toLowerCase();
            const date = reviewData.activity?.date ?
                reviewData.activity.date.replace(/[^0-9]/g, '') :
                new Date().toISOString().split('T')[0].replace(/-/g, '');

            const filename = `alltrails_${trailName}_${date}_${activityId}.json`;

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            log(`Saved review data: ${filename}`, 'SUCCESS');
            return true;
        } catch (error) {
            log(`Error saving review data: ${error.message}`, 'ERROR');
            return false;
        }
    }

    // ============================================================================
    // DOWNLOAD PROCESS
    // ============================================================================

    // Enhanced GPX download with robust selector fallbacks
    async function attemptGpxDownload() {
        const protectionInfo = ProtectionDetector.detectProtection();
        if (protectionInfo.detected) {
            ProtectionDetector.handleProtectionDetected(protectionInfo);
            return;
        }

        await HumanBehavior.randomInteraction();

        // Multiple selector strategies for finding the menu button
        const menuSelectors = [
            'button[aria-label*="more" i]',
            'button[title*="more" i]',
            '[data-testid="dots-vertical"]',
            'button:has([data-testid="dots-vertical"])',
            '[data-testid*="more"]',
            'button[aria-label*="menu" i]',
            '.more-menu-button',
            '[class*="more-menu"]',
            'button[class*="menu"]'
        ];

        let menuButton = null;
        for (const selector of menuSelectors) {
            menuButton = document.querySelector(selector);
            if (menuButton) {
                log(`Found menu button using selector: ${selector}`);
                break;
            }
        }

        if (!menuButton) {
            log('Menu button not found with any selector', 'ERROR');
            await randomDelay('clickDelay', 1000, 3000);
            markCurrentAsFailed();
            return;
        }

        log('Opening menu...');
        menuButton.style.border = '2px solid #4CAF50';
        await randomDelay('clickDelay', 300, 800);
        await HumanBehavior.humanClick(menuButton);
        await randomDelay('clickDelay');

        // Enhanced download option detection
        const downloadSelectors = [
            'li[role="menuitem"]',
            '.MuiMenuItem-root',
            '[role="menuitem"]',
            'li',
            'button',
            '[role="button"]',
            '[tabindex="0"]',
            '.menu-item',
            '[class*="menu-item"]'
        ];

        let downloadOption = null;
        const searchAttempts = 3;

        for (let attempt = 0; attempt < searchAttempts && !downloadOption; attempt++) {
            if (attempt > 0) {
                log(`Retry ${attempt} finding download option...`);
                await randomDelay('clickDelay', 500, 1200);
            }

            for (const selector of downloadSelectors) {
                const items = document.querySelectorAll(selector);
                for (const item of items) {
                    const text = (item.textContent || item.innerText || '').toLowerCase();
                    if (text.includes('download route') || 
                        text.includes('download') || 
                        text.includes('export') ||
                        text.includes('gpx')) {
                        downloadOption = item;
                        log(`Found download option: "${item.textContent.trim()}" via ${selector}`);
                        break;
                    }
                }
                if (downloadOption) break;
            }
        }

        if (!downloadOption) {
            log('Download option not found in menu after multiple attempts', 'ERROR');
            const availableOptions = Array.from(document.querySelectorAll('li[role="menuitem"], [role="menuitem"]'))
                .map(item => item.textContent.trim()).join(', ');
            log(`Available menu options: ${availableOptions}`);
            await randomDelay('clickDelay', 1000, 2500);
            markCurrentAsFailed();
            return;
        }

        log('Clicking download option...');
        downloadOption.style.background = '#ffeb3b';
        await randomDelay('clickDelay', 400, 900);
        await HumanBehavior.humanClick(downloadOption);
        await randomDelay('clickDelay');

        // Enhanced OK button detection
        const okSelectors = [
            '[data-testid="OK"]',
            'button[data-testid="OK"]',
            'button:contains("OK")',
            'button:contains("Download")',
            'button:contains("Export")',
            '[role="button"]:contains("OK")',
            '.ok-button',
            '.download-button',
            '.export-button'
        ];

        let okButton = null;
        const okSearchAttempts = 3;

        for (let attempt = 0; attempt < okSearchAttempts && !okButton; attempt++) {
            if (attempt > 0) {
                log(`Retry ${attempt} finding OK button...`);
                await randomDelay('clickDelay', 600, 1200);
            }

            for (const selector of okSelectors) {
                okButton = document.querySelector(selector);
                if (okButton) break;
            }

            // Fallback: search all buttons for OK/Download text
            if (!okButton) {
                const allButtons = document.querySelectorAll('button');
                for (const btn of allButtons) {
                    const text = btn.textContent.toLowerCase();
                    if (text.includes('ok') || text.includes('download') || text.includes('export')) {
                        okButton = btn;
                        break;
                    }
                }
            }
        }

        if (okButton) {
            log('Found OK button, performing download...');
            await randomDelay('clickDelay', 200, 600);
            await HumanBehavior.humanClick(okButton);
            markCurrentAsSuccess();
        } else {
            log('OK button not found, checking for download indicators...');

            // Check for download dialogs or progress indicators
            const downloadIndicators = [
                '[role="dialog"]',
                '[class*="download"]',
                '[class*="progress"]',
                '.download-dialog',
                '.export-dialog'
            ];

            let downloadDetected = false;
            for (const selector of downloadIndicators) {
                if (document.querySelector(selector)) {
                    downloadDetected = true;
                    break;
                }
            }

            if (downloadDetected) {
                log('Download dialog/progress detected, assuming success');
                markCurrentAsSuccess();
            } else {
                log('No download indicators found, waiting longer...');
                await randomDelay('clickDelay', 2000, 4000);

                // Final check
                const finalDialog = document.querySelector('[role="dialog"]');
                if (finalDialog) {
                    log('Delayed download dialog detected, marking success');
                    markCurrentAsSuccess();
                } else {
                    log('No download confirmation, but assuming success (may have auto-downloaded)');
                    markCurrentAsSuccess();
                }
            }
        }
    }

    // Mark current download as successful
    async function markCurrentAsSuccess() {
        const pendingUrls = state.get('pendingUrls') || [];
        if (pendingUrls.length === 0) return;

        const currentUrl = pendingUrls[0];
        const downloadedCount = state.get('downloadedCount') || 0;

        state.set('downloadedCount', downloadedCount + 1);
        state.removeProcessedUrl(currentUrl);

        log(`Success: ${currentUrl.split('/').pop()} (GPX${CONFIG.saveReviewData ? ' + JSON' : ''})`, 'SUCCESS');

        const successDelay = RND.delay('downloadDelay');
        await sleep(successDelay);

        moveToNextHike();
    }

    // Mark current download as failed
    async function markCurrentAsFailed() {
        const pendingUrls = state.get('pendingUrls') || [];
        if (pendingUrls.length === 0) return;

        const currentUrl = pendingUrls[0];
        const failedCount = state.get('failedCount') || 0;

        state.set('failedCount', failedCount + 1);
        state.removeProcessedUrl(currentUrl);

        log(`Failed: ${currentUrl.split('/').pop()}`, 'ERROR');

        await randomDelay('clickDelay', 1500, 3000);
        moveToNextHike();
    }

    // Move to next hike in queue
    async function moveToNextHike() {
        const pendingUrls = state.get('pendingUrls') || [];

        if (pendingUrls.length === 0) {
            finishDownload();
            return;
        }

        const nextUrl = pendingUrls[0];
        log(`Moving to next hike: ${nextUrl.split('/').pop()} (${pendingUrls.length} remaining)`);

        setMode('downloading');
        await randomDelay('clickDelay', 800, 2000);
        window.location.href = nextUrl;
    }

    // Finish download process
    async function finishDownload() {
        const downloadedCount = state.get('downloadedCount') || 0;
        const failedCount = state.get('failedCount') || 0;
        const totalProcessed = downloadedCount + failedCount;

        log(`Download process complete! Downloaded: ${downloadedCount}, Failed: ${failedCount}`, 'SUCCESS');
        setMode('idle');

        const reviewText = CONFIG.saveReviewData ? ' (with review data)' : '';
        const behaviorText = CONFIG.humanLikeBehavior ? ' using human-like behavior' : '';
        alert(`Download complete!${reviewText}${behaviorText}\n\n✅ Downloaded: ${downloadedCount}\n❌ Failed: ${failedCount}\n📊 Total: ${totalProcessed}`);

        // Return to original starting URL
        const originalUrl = state.get('originalStartingUrl');
        const returnUrl = originalUrl || 'https://www.alltrails.com/members/recordings';

        log(`Returning to original page: ${returnUrl}`);
        await randomDelay('clickDelay', 1500, 3000);
        window.location.href = returnUrl;
    }

    // ============================================================================
    // URL DISCOVERY
    // ============================================================================

    // Start URL discovery process
    async function startDiscovery() {
        const currentUrl = window.location.href;

        if (!currentUrl.includes('recordings')) {
            alert('Please navigate to your AllTrails Activities page first!\n\nGo to: https://www.alltrails.com/members/your-username/recordings');
            return;
        }

        state.set('originalStartingUrl', currentUrl);
        log(`Starting URL discovery from: ${currentUrl}`);

        const protectionInfo = ProtectionDetector.detectProtection();
        if (protectionInfo.detected) {
            ProtectionDetector.handleProtectionDetected(protectionInfo);
            return;
        }

        await HumanBehavior.simulateReading();
        setMode('discovering');
        const existingUrls = state.get('discoveredUrls') || [];
        state.set('scrollAttempts', 0);

        log(`Starting URL discovery process... (${existingUrls.length} existing)`);
        await randomDelay('pageLoadWait');
        location.reload();
    }

    // Handle URL discovery process
    async function handleDiscovery() {
        log('Running URL discovery...');

        const protectionInfo = ProtectionDetector.detectProtection();
        if (protectionInfo.detected) {
            ProtectionDetector.handleProtectionDetected(protectionInfo);
            return;
        }

        await HumanBehavior.simulateReading();

        const existingUrls = new Set(state.get('discoveredUrls') || []);
        const scrollAttempts = state.get('scrollAttempts') || 0;

        // Enhanced link detection with multiple selectors
        const linkSelectors = [
            'a[href*="/explore/recording/"]',
            'a[href*="/activity/"]',
            '[href*="/recording/"]',
            'a[data-testid*="recording"]',
            '.recording-link',
            '[class*="recording-link"]'
        ];

        let currentLinks = new Set();
        for (const selector of linkSelectors) {
            const links = document.querySelectorAll(selector);
            links.forEach(link => {
                if (link.href && link.href.includes('/explore/recording/')) {
                    currentLinks.add(link.href);
                }
            });
        }

        let newUrls = 0;
        currentLinks.forEach(href => {
            if (!existingUrls.has(href)) {
                existingUrls.add(href);
                newUrls++;
            }
        });

        const totalUrls = existingUrls.size;
        log(`Found ${newUrls} new URLs, total: ${totalUrls}`);

        const urlArray = Array.from(existingUrls);
        state.set('discoveredUrls', urlArray);

        const processedUrls = state.get('processedUrls') || [];
        const processedUrlSet = new Set(processedUrls.map(p => p.url));
        const pendingUrls = urlArray.filter(url => !processedUrlSet.has(url));
        state.set('pendingUrls', pendingUrls);

        setMode('discovering');

        if (newUrls === 0 && scrollAttempts > 3) {
            log(`Discovery complete! Found ${totalUrls} total URLs, ${pendingUrls.length} pending`);
            setMode('idle');
            alert(`Discovery complete!\n\nTotal URLs: ${totalUrls}\nNew/Pending: ${pendingUrls.length}\nAlready processed: ${totalUrls - pendingUrls.length}`);
            await randomDelay('clickDelay');

            const originalUrl = state.get('originalStartingUrl');
            if (originalUrl && originalUrl !== window.location.href) {
                log(`Returning to original page: ${originalUrl}`);
                window.location.href = originalUrl;
            } else {
                location.reload();
            }
            return;
        }

        if (scrollAttempts >= CONFIG.maxScrollAttempts) {
            log('Maximum scroll attempts reached');
            setMode('idle');
            alert(`Discovery stopped.\n\nFound ${totalUrls} URLs.\nPending: ${pendingUrls.length}`);
            await randomDelay('clickDelay');

            const originalUrl = state.get('originalStartingUrl');
            if (originalUrl && originalUrl !== window.location.href) {
                log(`Returning to original page: ${originalUrl}`);
                window.location.href = originalUrl;
            } else {
                location.reload();
            }
            return;
        }

        const currentScroll = window.pageYOffset;
        const scrollAmount = RND.scrollAmount(3000);
        await HumanBehavior.humanScroll(scrollAmount);
        state.set('scrollAttempts', scrollAttempts + 1);

        await randomDelay('scrollDelay');

        const newScroll = window.pageYOffset;
        if (newScroll === currentScroll) {
            log(`Reached end of page. Discovery complete with ${totalUrls} URLs`);
            setMode('idle');
            alert(`Discovery complete!\n\nTotal: ${totalUrls} URLs\nPending: ${pendingUrls.length}`);
            await randomDelay('clickDelay');

            const originalUrl = state.get('originalStartingUrl');
            if (originalUrl && originalUrl !== window.location.href) {
                log(`Returning to original page: ${originalUrl}`);
                window.location.href = originalUrl;
            } else {
                location.reload();
            }
        } else {
            await randomDelay('scrollDelay');
            setTimeout(() => handleDiscovery(), RND.int(500, 1500));
        }
    }

    // ============================================================================
    // DOWNLOAD MANAGEMENT
    // ============================================================================

    // Start download process
    async function startDownload() {
        const pendingUrls = state.get('pendingUrls') || [];
        if (pendingUrls.length === 0) {
            alert('No URLs to download!\n\n• Run discovery first using "1. Discover URLs"\n• Or import URLs using the 📂 button');
            return;
        }

        const protectionInfo = ProtectionDetector.detectProtection();
        if (protectionInfo.detected) {
            ProtectionDetector.handleProtectionDetected(protectionInfo);
            return;
        }

        await HumanBehavior.simulateReading();
        setMode('downloading');
        state.set('currentUrlIndex', 0);

        const behaviorText = CONFIG.humanLikeBehavior ? ' with anti-bot protection' : '';
        log(`Starting download of ${pendingUrls.length} URLs... (GPX + ${CONFIG.saveReviewData ? 'JSON' : 'no JSON'})${behaviorText}`);

        await randomDelay('clickDelay');
        window.location.href = pendingUrls[0];
    }

    // Handle download process
    async function handleDownload() {
        const protectionInfo = ProtectionDetector.detectProtection();
        if (protectionInfo.detected) {
            ProtectionDetector.handleProtectionDetected(protectionInfo);
            return;
        }

        const pendingUrls = state.get('pendingUrls') || [];

        if (pendingUrls.length === 0) {
            log('No pending URLs, finishing download');
            finishDownload();
            return;
        }

        const currentUrl = pendingUrls[0];
        log(`Processing: ${currentUrl.split('/').pop()}`);

        setMode('downloading', { currentUrl });

        const downloadTimeout = setTimeout(() => {
            log('Download timeout, marking as failed', 'WARN');
            markCurrentAsFailed();
        }, CONFIG.processTimeout);

        const pageLoadDelay = RND.delay('pageLoadWait');
        await sleep(pageLoadDelay);

        try {
            clearTimeout(downloadTimeout);

            await HumanBehavior.simulateReading();

            if (CONFIG.saveReviewData) {
                log('Extracting review data...');
                const reviewData = extractReviewData();
                saveReviewDataAsJson(reviewData);
                await randomDelay('clickDelay');
            }

            await attemptGpxDownload();

        } catch (error) {
            clearTimeout(downloadTimeout);
            log(`Download error: ${error.message}`, 'ERROR');
            markCurrentAsFailed();
        }
    }

    // ============================================================================
    // USER INTERFACE
    // ============================================================================

    // Update UI function
    function updateUI() {
        const ui = document.getElementById('alltrails-downloader-ui');
        if (ui) {
            ui.remove();
            addUI();
        }
    }

    // Enhanced UI with comprehensive status display
    function addUI() {
        const existingUI = document.getElementById('alltrails-downloader-ui');
        if (existingUI) {
            existingUI.remove();
        }

        const ui = document.createElement('div');
        ui.id = 'alltrails-downloader-ui';
        ui.style.cssText = `
            position: fixed; top: 10px; left: 10px; background: #fff; border: 2px solid #4CAF50;
            border-radius: 8px; padding: 12px; z-index: 10000; font-family: Arial, sans-serif;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 320px; max-height: 70vh;
            overflow-y: auto; font-size: 13px;
        `;

        const currentMode = getCurrentMode();
        const allDiscoveredUrls = state.get('discoveredUrls') || [];
        const pendingUrls = state.get('pendingUrls') || [];
        const downloadedCount = state.get('downloadedCount') || 0;
        const failedCount = state.get('failedCount') || 0;
        const lastActivity = state.get('lastActivity') || 0;
        const timeSinceActivity = Date.now() - lastActivity;
        const captchaInfo = state.get('captchaDetected');
        const rateLimitedUrls = state.get('rateLimitedUrls') || [];

        const currentUrl = window.location.href;
        const isStuck = currentMode !== 'idle' && currentMode !== 'captcha_paused' && currentMode !== 'rate_limit_backoff' && timeSinceActivity > CONFIG.processTimeout;
        const isCaptchaPaused = currentMode === 'captcha_paused';
        const isRateLimited = currentMode === 'rate_limit_backoff';

        ui.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <h3 style="margin: 0; color: ${isCaptchaPaused ? '#ff4444' : isRateLimited ? '#ff9800' : '#4CAF50'}; font-size: 14px;">
                    ${SCRIPT_NAME} v${VERSION} ${isCaptchaPaused ? '(CAPTCHA)' : isRateLimited ? '(RATE LIMITED)' : ''}
                </h3>
                <button id="toggle-ui" style="background: none; border: 1px solid #ccc; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 12px;">−</button>
            </div>

            <div id="ui-content">
                <div style="background: ${isCaptchaPaused ? '#ffe6e6' : isRateLimited ? '#fff3e0' : isStuck ? '#ffe6e6' : '#f0f8ff'}; padding: 6px; border-radius: 4px; margin: 5px 0; font-size: 12px;">
                    <strong>Status:</strong> ${currentMode} ${isCaptchaPaused ? '(paused)' : isRateLimited ? '(backing off)' : isStuck ? '(stuck)' : '(ready)'}<br>
                    <strong>Progress:</strong> Downloaded: ${downloadedCount} | Failed: ${failedCount} | Pending: ${pendingUrls.length} ${rateLimitedUrls.length > 0 ? `| Rate Limited: ${rateLimitedUrls.length}` : ''}
                    ${isCaptchaPaused ? `<br><strong style="color: #ff4444;">CAPTCHA DETECTED - PAUSED</strong>` : ''}
                    ${isRateLimited ? `<br><strong style="color: #ff9800;">RATE LIMITED - MOVING TO NEXT</strong>` : ''}
                    ${pendingUrls.length > 0 && !isCaptchaPaused && !isRateLimited ? `
                        <div style="background: #ddd; height: 4px; border-radius: 2px; margin: 3px 0;">
                            <div style="background: #4CAF50; height: 4px; border-radius: 2px; width: ${((downloadedCount + failedCount) / (downloadedCount + failedCount + pendingUrls.length) * 100)}%;"></div>
                        </div>
                    ` : ''}
                </div>

                ${isCaptchaPaused && captchaInfo ? `
                    <div style="margin: 6px 0; padding: 6px; background: #ffe6e6; border-radius: 4px; font-size: 11px; color: #cc0000;">
                        <strong>CAPTCHA PROTECTION ACTIVE</strong><br>
                        Type: ${captchaInfo.type || 'Unknown'}<br>
                        Detected: ${new Date(captchaInfo.timestamp).toLocaleTimeString()}<br>
                        <em>Complete CAPTCHA manually, then resume</em>
                    </div>
                ` : ''}

                ${rateLimitedUrls.length > 0 ? `
                    <div style="margin: 6px 0; padding: 6px; background: #fff3e0; border-radius: 4px; font-size: 11px; color: #f57c00;">
                        <strong>RATE LIMITED FILES</strong><br>
                        Count: ${rateLimitedUrls.length} files moved to end of queue<br>
                        ${CONFIG.adaptiveDelays ? 'Adaptive delays: ACTIVE (increased 50%)' : 'Adaptive delays: INACTIVE'}<br>
                        <button id="disable-rate-limit" style="background: #ff5722; color: white; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; margin-top: 4px;">
                            Reset Rate Limit Mode
                        </button>
                    </div>
                ` : ''}

                <div style="margin: 6px 0; padding: 6px; background: #f5f5f5; border-radius: 4px; font-size: 11px;">
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="checkbox" id="save-review-data" ${CONFIG.saveReviewData ? 'checked' : ''} style="margin-right: 6px;">
                        <span>Save review data as JSON</span>
                    </label>
                    <label style="display: flex; align-items: center; cursor: pointer; margin-top: 4px;">
                        <input type="checkbox" id="human-behavior" ${CONFIG.humanLikeBehavior ? 'checked' : ''} style="margin-right: 6px;">
                        <span>Human-like behavior (anti-bot)</span>
                    </label>
                </div>

                <div style="margin: 8px 0;">
                    <button id="start-discovery" style="background: #2196F3; color: white; border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; margin: 1px; width: 100%; font-size: 12px;" ${currentMode === 'discovering' || isCaptchaPaused ? 'disabled' : ''}>
                        ${currentMode === 'discovering' ? 'Discovering...' : '1. Discover URLs'}
                    </button>

                    <button id="start-download" style="background: #4CAF50; color: white; border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; margin: 1px; width: 100%; font-size: 12px;" ${pendingUrls.length === 0 || currentMode === 'downloading' || isCaptchaPaused ? 'disabled' : ''}>
                        ${currentMode === 'downloading' ? 'Downloading...' : `2. Download GPX+JSON (${pendingUrls.length})`}
                    </button>

                    ${currentUrl.includes('/explore/recording/') && !isCaptchaPaused && !isRateLimited ? `
                    <button id="test-extract" style="background: #9C27B0; color: white; border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; margin: 1px; width: 100%; font-size: 12px;">
                        Test Data Extract
                    </button>
                    ` : ''}

                    ${isCaptchaPaused ? `
                    <button id="resume-after-captcha" style="background: #FF9800; color: white; border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; margin: 1px; width: 100%; font-size: 12px;">
                        Resume After CAPTCHA
                    </button>
                    ` : ''}

                    ${isStuck && !isCaptchaPaused && !isRateLimited ? `
                    <button id="recover-stuck" style="background: #FF5722; color: white; border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; margin: 1px; width: 100%; font-size: 12px;">
                        Recover
                    </button>
                    ` : ''}

                    ${pendingUrls.length > 0 && currentMode === 'idle' && !isCaptchaPaused && !isRateLimited ? `
                    <button id="resume-download" style="background: #8BC34A; color: white; border: none; padding: 6px 8px; border-radius: 4px; cursor: pointer; margin: 1px; width: 100%; font-size: 12px;">
                        Resume
                    </button>
                    ` : ''}
                </div>

                <div style="display: flex; gap: 2px;">
                    <button id="show-progress" style="background: #9C27B0; color: white; border: none; padding: 4px 6px; border-radius: 4px; cursor: pointer; flex: 1; font-size: 11px;" ${allDiscoveredUrls.length === 0 ? 'disabled' : ''}>
                        Progress
                    </button>
                    <button id="export-remaining" style="background: #607D8B; color: white; border: none; padding: 4px 6px; border-radius: 4px; cursor: pointer; flex: 1; font-size: 11px;" ${pendingUrls.length === 0 ? 'disabled' : ''}>
                        Export
                    </button>
                    <button id="import-urls" style="background: #795548; color: white; border: none; padding: 4px 6px; border-radius: 4px; cursor: pointer; flex: 1; font-size: 11px;" ${isCaptchaPaused || isRateLimited ? 'disabled' : ''}>
                        Import
                    </button>
                    <button id="stop-all" style="background: #f44336; color: white; border: none; padding: 4px 6px; border-radius: 4px; cursor: pointer; flex: 1; font-size: 11px;">
                        Stop
                    </button>
                </div>

                ${CONFIG.humanLikeBehavior && !isCaptchaPaused && !isRateLimited ? `
                    <div style="margin-top: 6px; padding: 4px; background: #e8f5e8; border-radius: 4px; font-size: 10px; color: #555;">
                        Anti-bot active: Randomized delays (${CONFIG.downloadDelay.min/1000}-${CONFIG.downloadDelay.max/1000}s), human clicks, smart scrolling
                        ${CONFIG.adaptiveDelays ? '<br>Adaptive delays: Increased due to rate limiting' : ''}
                    </div>
                ` : ''}

                <div style="margin-top: 6px; padding: 4px; background: #e8f4fd; border-radius: 4px; font-size: 10px; color: #555;">
                    Protection: Auto-monitoring every ${CONFIG.captchaCheckInterval/1000}s
                    ${rateLimitedUrls.length > 0 ? `<br>Rate limit mode: ${rateLimitedUrls.length} files in queue, adaptive delays ${CONFIG.adaptiveDelays ? 'ON' : 'OFF'}` : ''}
                </div>

                ${state.get('originalStartingUrl') ? `
                    <div style="margin-top: 6px; padding: 4px; background: #f0f8ff; border-radius: 4px; font-size: 10px; color: #555;">
                        Will return to: ${state.get('originalStartingUrl').split('/').slice(-2).join('/')}
                    </div>
                ` : ''}

                ${currentMode === 'downloading' && pendingUrls.length > 0 && !isCaptchaPaused && !isRateLimited ? `
                    <div style="margin-top: 8px; padding: 6px; background: #e8f5e8; border-radius: 4px; font-size: 11px;">
                        <strong>Current:</strong> ${pendingUrls[0] ? pendingUrls[0].split('/').pop().substr(0, 20) + '...' : 'N/A'}
                    </div>
                ` : ''}
            </div>
        `;

        document.body.appendChild(ui);

        // Add event listeners
        document.getElementById('start-discovery').onclick = () => startDiscovery();
        document.getElementById('start-download').onclick = () => startDownload();

        // Disable rate limit button
        const disableRateLimitBtn = document.getElementById('disable-rate-limit');
        if (disableRateLimitBtn) {
            disableRateLimitBtn.onclick = () => disableRateLimitMode();
        }

        // Configuration toggles
        document.getElementById('save-review-data').onchange = (e) => {
            CONFIG.saveReviewData = e.target.checked;
            log(`Review data saving ${CONFIG.saveReviewData ? 'enabled' : 'disabled'}`);
        };

        document.getElementById('human-behavior').onchange = (e) => {
            CONFIG.humanLikeBehavior = e.target.checked;
            log(`Human-like behavior ${CONFIG.humanLikeBehavior ? 'enabled' : 'disabled'}`);
            setTimeout(() => location.reload(), 500);
        };

        // Test extract button
        const testExtractBtn = document.getElementById('test-extract');
        if (testExtractBtn) {
            testExtractBtn.onclick = async () => {
                await HumanBehavior.simulateReading();
                const reviewData = extractReviewData();
                if (saveReviewDataAsJson(reviewData)) {
                    alert('✅ Test extraction successful! Check your downloads.');
                } else {
                    alert('❌ Test extraction failed. Check console for errors.');
                }
            };
        }

        // Resume after CAPTCHA button
        const resumeAfterCaptchaBtn = document.getElementById('resume-after-captcha');
        if (resumeAfterCaptchaBtn) {
            resumeAfterCaptchaBtn.onclick = () => {
                ProtectionDetector.resumeAfterCaptcha();
            };
        }

        // Toggle UI
        document.getElementById('toggle-ui').onclick = () => {
            const content = document.getElementById('ui-content');
            const btn = document.getElementById('toggle-ui');
            if (content.style.display === 'none') {
                content.style.display = 'block';
                btn.textContent = '−';
            } else {
                content.style.display = 'none';
                btn.textContent = '+';
            }
        };

        const recoverBtn = document.getElementById('recover-stuck');
        if (recoverBtn) recoverBtn.onclick = () => recoverFromStuck();

        const resumeBtn = document.getElementById('resume-download');
        if (resumeBtn) resumeBtn.onclick = () => resumeDownload();

        document.getElementById('show-progress').onclick = () => showDetailedProgress();
        document.getElementById('export-remaining').onclick = () => exportRemainingUrls();
        document.getElementById('import-urls').onclick = () => importUrls();
        document.getElementById('stop-all').onclick = () => {
            stopAll();
            setTimeout(() => location.reload(), 500);
        };
    }

    // ============================================================================
    // UTILITY FUNCTIONS FOR UI
    // ============================================================================

    // Enhanced URL import with proper dialog
    function importUrls() {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.8); z-index: 50000; display: flex;
            align-items: center; justify-content: center;
        `;

        modal.innerHTML = `
            <div style="background: white; padding: 20px; border-radius: 8px; max-width: 600px; width: 80%;">
                <h3 style="margin: 0 0 15px 0;">Import URLs</h3>
                <p style="margin: 0 0 10px 0; font-size: 14px;">Paste your AllTrails recording URLs below (one per line):</p>
                <textarea id="url-input" placeholder="https://www.alltrails.com/explore/recording/..." 
                    style="width: 100%; height: 300px; font-family: monospace; font-size: 12px; border: 1px solid #ccc; padding: 8px; resize: vertical;"></textarea>
                <div style="margin-top: 15px; text-align: right;">
                    <button id="cancel-import" style="background: #666; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; margin-right: 10px;">Cancel</button>
                    <button id="confirm-import" style="background: #4CAF50; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer;">Import</button>
                </div>
                <div id="import-status" style="margin-top: 10px; font-size: 12px; color: #666;"></div>
            </div>
        `;

        document.body.appendChild(modal);

        const textarea = document.getElementById('url-input');
        const statusDiv = document.getElementById('import-status');
        
        textarea.focus();

        const updateStatus = () => {
            const text = textarea.value;
            let lines = [];
            
            if (text.includes('\\n')) {
                lines = text.split('\\n');
            } else if (text.includes('\n')) {
                lines = text.split('\n');
            } else {
                lines = [text];
            }
            
            lines = lines.filter(line => line.trim().length > 0);
            const validUrls = lines.filter(line => 
                line.includes('/explore/recording/') || line.includes('alltrails.com')
            );
            
            const method = text.includes('\\n') ? ' (literal \\n)' : text.includes('\n') ? ' (newlines)' : ' (single)';
            statusDiv.textContent = `${lines.length} lines, ${validUrls.length} valid AllTrails URLs${method}`;
        };

        textarea.addEventListener('input', updateStatus);
        textarea.addEventListener('paste', () => {
            setTimeout(updateStatus, 10);
        });

        document.getElementById('cancel-import').onclick = () => {
            document.body.removeChild(modal);
        };

        document.getElementById('confirm-import').onclick = () => {
            const urlText = textarea.value;
            
            if (!urlText.trim()) {
                alert('Please paste some URLs first!');
                return;
            }

            log(`Import: Input length ${urlText.length}, contains newlines: ${urlText.includes('\n')}, contains \\n: ${urlText.includes('\\n')}`);

            let urls = [];
            
            if (urlText.includes('\\n')) {
                urls = urlText.split('\\n');
                log('Import: Using literal \\n splitting (original method)');
            } else if (urlText.includes('\n')) {
                urls = urlText.split('\n');
                log('Import: Using actual newline splitting');
            } else {
                urls = [urlText];
                log('Import: Single URL mode');
            }

            urls = urls
                .map(url => url.trim())
                .filter(url => url.includes('/explore/recording/') || url.includes('alltrails.com'))
                .filter(url => url.length > 0);

            log(`Import: Found ${urls.length} valid URLs after processing`);

            if (urls.length === 0) {
                alert(`No valid AllTrails URLs found!\n\nMake sure URLs contain '/explore/recording/' or 'alltrails.com'`);
                return;
            }

            const normalizedUrls = urls.map(url => {
                if (!url.startsWith('http')) {
                    return 'https://www.alltrails.com/explore/recording/' + url;
                }
                return url;
            });

            const existingUrls = state.get('discoveredUrls') || [];
            const allUrls = [...new Set([...existingUrls, ...normalizedUrls])];

            state.set('discoveredUrls', allUrls);
            state.set('pendingUrls', normalizedUrls);
            setMode('idle');

            document.body.removeChild(modal);
            alert(`Successfully imported ${normalizedUrls.length} URLs!\nTotal discovered: ${allUrls.length}`);
            setTimeout(() => location.reload(), 500);
        };

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });

        document.addEventListener('keydown', function escapeHandler(e) {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escapeHandler);
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal);
                }
            }
        });
    }

    // Enhanced progress display
    function showDetailedProgress() {
        const allUrls = state.get('discoveredUrls') || [];
        const pendingUrls = state.get('pendingUrls') || [];
        const downloadedCount = state.get('downloadedCount') || 0;
        const failedCount = state.get('failedCount') || 0;
        const rateLimitedUrls = state.get('rateLimitedUrls') || [];

        if (allUrls.length === 0) {
            alert('No URLs discovered yet!\n\nUse "1. Discover URLs" first or import URLs with 📂');
            return;
        }

        const modal = document.createElement('div');
        modal.id = 'progress-modal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.8); z-index: 30000; display: flex;
            align-items: center; justify-content: center;
        `;

        const behaviorStatus = CONFIG.humanLikeBehavior ? '🧑 Human-like' : '🤖 Standard';
        const delayInfo = CONFIG.humanLikeBehavior ?
            `(${CONFIG.downloadDelay.min/1000}-${CONFIG.downloadDelay.max/1000}s delays)` :
            `(${CONFIG.downloadDelay.min/1000}s delays)`;

        modal.innerHTML = `
            <div style="background: white; padding: 20px; border-radius: 8px; max-width: 80%; max-height: 80%; overflow-y: auto; min-width: 500px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="margin: 0;">${SCRIPT_NAME} v${VERSION} - Progress Report</h3>
                    <button id="close-modal" style="background: #f44336; color: white; border: none; padding: 8px 12px; border-radius: 4px; cursor: pointer;">Close</button>
                </div>

                <div style="margin: 10px 0; padding: 8px; background: #f0f8ff; border-radius: 4px; font-size: 12px;">
                    <strong>Mode:</strong> ${behaviorStatus} ${delayInfo}<br>
                    <strong>Features:</strong> GPX${CONFIG.saveReviewData ? ' + JSON' : ''} downloads + CAPTCHA detection<br>
                    <strong>Protection:</strong> Auto-monitoring every ${CONFIG.captchaCheckInterval/1000}s<br>
                    <strong>Rate Limits:</strong> Move to end of queue, retry later (adaptive delays: ${CONFIG.adaptiveDelays ? 'ON' : 'OFF'})
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px; margin: 15px 0;">
                    <div style="text-align: center; padding: 10px; background: #e8f5e8; border-radius: 4px;">
                        <h4 style="margin: 5px 0; color: #4CAF50;">Downloaded</h4>
                        <div style="font-size: 24px; font-weight: bold;">${downloadedCount}</div>
                        <div style="font-size: 12px; color: #666;">GPX${CONFIG.saveReviewData ? ' + JSON' : ''}</div>
                    </div>
                    <div style="text-align: center; padding: 10px; background: #ffe8e8; border-radius: 4px;">
                        <h4 style="margin: 5px 0; color: #f44336;">Failed</h4>
                        <div style="font-size: 24px; font-weight: bold;">${failedCount}</div>
                    </div>
                    <div style="text-align: center; padding: 10px; background: #e8f4fd; border-radius: 4px;">
                        <h4 style="margin: 5px 0; color: #2196F3;">Pending</h4>
                        <div style="font-size: 24px; font-weight: bold;">${pendingUrls.length}</div>
                    </div>
                    <div style="text-align: center; padding: 10px; background: #fff3e0; border-radius: 4px;">
                        <h4 style="margin: 5px 0; color: #ff9800;">Rate Limited</h4>
                        <div style="font-size: 24px; font-weight: bold;">${rateLimitedUrls.length}</div>
                        <div style="font-size: 12px; color: #666;">In queue</div>
                    </div>
                </div>

                <div style="margin: 15px 0;">
                    <h4>Pending URLs (${pendingUrls.length}):</h4>
                    <textarea readonly style="width: 100%; height: 200px; font-family: monospace; font-size: 11px; border: 1px solid #ccc; padding: 8px;">
${pendingUrls.map(url => url.split('/').pop()).join('\n')}
                    </textarea>
                </div>

                ${rateLimitedUrls.length > 0 ? `
                <div style="margin: 15px 0;">
                    <h4>Rate Limited URLs (${rateLimitedUrls.length}):</h4>
                    <textarea readonly style="width: 100%; height: 150px; font-family: monospace; font-size: 11px; border: 1px solid #ccc; padding: 8px;">
${rateLimitedUrls.map(r => `${r.url.split('/').pop()} (attempt ${r.attempts}/3)`).join('\n')}
                    </textarea>
                </div>
                ` : ''}
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('close-modal').addEventListener('click', function() {
            document.body.removeChild(modal);
        });

        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });
    }

    // Export remaining URLs
    function exportRemainingUrls() {
        const pendingUrls = state.get('pendingUrls') || [];
        if (pendingUrls.length === 0) {
            alert('No URLs to export!');
            return;
        }

        const urlText = pendingUrls.join('\n');
        const blob = new Blob([urlText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `alltrails_remaining_${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert(`Exported ${pendingUrls.length} remaining URLs!`);
    }

    // Disable rate limit mode
    function disableRateLimitMode() {
        log('Manually disabling rate limit mode...');
        
        CONFIG.rateLimitDetected = false;
        CONFIG.adaptiveDelays = false;
        
        // Reset delays to original values
        CONFIG.downloadDelay.min = 90000;
        CONFIG.downloadDelay.max = 185000;
        CONFIG.clickDelay.min = 1000;
        CONFIG.clickDelay.max = 4500;
        
        state.set('rateLimitedUrls', []);
        
        const currentMode = getCurrentMode();
        if (currentMode === 'rate_limit_backoff') {
            const pendingUrls = state.get('pendingUrls') || [];
            if (pendingUrls.length > 0) {
                setMode('downloading');
                log('Resuming download after disabling rate limit mode');
            } else {
                setMode('idle');
            }
        }
        
        const notification = document.getElementById('rate-limit-notification');
        if (notification) {
            notification.remove();
        }
        
        log('Rate limit mode disabled. Delays reset to original values.', 'SUCCESS');
        alert('Rate limit mode disabled!\n\nDelays reset to original values.\nRate limit tracking cleared.');
    }

    // Recovery functions
    async function recoverFromStuck() {
        log('Manual recovery initiated');
        await HumanBehavior.simulateReading();
        const currentMode = getCurrentMode();

        if (currentMode === 'captcha_paused') {
            ProtectionDetector.resumeAfterCaptcha();
            return;
        }

        if (currentMode === 'downloading') {
            markCurrentAsFailed();
        } else {
            setMode('idle');
            setTimeout(() => location.reload(), 500);
        }
    }

    function resumeDownload() {
        log('Resuming download');
        startDownload();
    }

    // Stop all processes
    function stopAll() {
        const captchaNotification = document.getElementById('captcha-notification');
        if (captchaNotification) {
            captchaNotification.remove();
        }

        const rateLimitNotification = document.getElementById('rate-limit-notification');
        if (rateLimitNotification) {
            rateLimitNotification.remove();
        }

        state.clear();
        log('All processes stopped and state cleared', 'SUCCESS');
    }

    // ============================================================================
    // AUTO-RECOVERY AND MONITORING
    // ============================================================================

    // Check if process is stuck and auto-recover
    function checkAndRecoverStuckProcess() {
        const lastActivity = state.get('lastActivity') || 0;
        const currentMode = getCurrentMode();
        const timeSinceActivity = Date.now() - lastActivity;

        if (currentMode === 'captcha_paused') {
            log('In CAPTCHA mode, skipping auto-recovery');
            return false;
        }

        if (currentMode === 'rate_limit_backoff') {
            log('In rate limit backoff mode, skipping auto-recovery');
            return false;
        }

        if (currentMode !== 'idle' && timeSinceActivity > CONFIG.stuckTimeout) {
            log(`Process stuck in ${currentMode} for ${Math.round(timeSinceActivity/1000)}s. Auto-recovering...`, 'WARN');

            if (currentMode === 'downloading') {
                const pendingUrls = state.get('pendingUrls') || [];
                const currentIndex = state.get('currentUrlIndex') || 0;

                if (pendingUrls[currentIndex]) {
                    log(`Marking stuck URL as failed: ${pendingUrls[currentIndex]}`);
                    markCurrentAsFailed();
                    return true;
                }
            }

            setMode('idle');
            return true;
        }
        return false;
    }

    // Heartbeat system for monitoring
    function startHeartbeat() {
        setInterval(() => {
            if (getCurrentMode() !== 'idle') {
                state.set('lastHeartbeat', Date.now());
            }
        }, CONFIG.heartbeatInterval);
    }

    // ============================================================================
    // MAIN EXECUTION
    // ============================================================================

    function main() {
        try {
            log(`${SCRIPT_NAME} v${VERSION} initializing...`);

            if (CONFIG.autoRestart) {
                checkAndRecoverStuckProcess();
            }

            addUI();
            startHeartbeat();
            ProtectionDetector.startMonitoring();

            const currentMode = getCurrentMode();
            const currentUrl = window.location.href;

            // Don't proceed if in protection modes
            if (currentMode === 'captcha_paused') {
                log('Script paused due to CAPTCHA detection');
                return;
            }

            if (currentMode === 'rate_limit_backoff') {
                log('Script in rate limit backoff mode');
                return;
            }

            // Handle different modes and URLs
            if (currentMode === 'discovering' && currentUrl.includes('recordings')) {
                setTimeout(() => handleDiscovery(), RND.delay('pageLoadWait'));
            } else if (currentMode === 'downloading' && currentUrl.includes('/explore/recording/')) {
                handleDownload();
            }

            log(`${SCRIPT_NAME} v${VERSION} ready!`, 'SUCCESS');

        } catch (error) {
            log(`Main execution error: ${error.message}`, 'ERROR');
            console.error(error);
        }
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        setTimeout(main, RND.int(800, 2000));
    }

    // Global error handler
    window.addEventListener('error', (event) => {
        log(`Global error: ${event.error.message}`, 'ERROR');
        console.error(`${SCRIPT_NAME} error:`, event.error);
    });

    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && getCurrentMode() !== 'idle') {
            log('Page became visible, checking process status');
            setTimeout(() => {
                const detectionResult = ProtectionDetector.detectProtection();
                if (detectionResult.detected) {
                    ProtectionDetector.handleProtectionDetected(detectionResult);
                    return;
                }

                if (checkAndRecoverStuckProcess()) {
                    setTimeout(() => location.reload(), RND.int(800, 1500));
                }
            }, RND.int(1500, 3000));
        }
    });

    // ============================================================================
    // SCRIPT INFO AND WELCOME MESSAGE
    // ============================================================================

    // Show welcome message on first load
    if (!state.get('welcomeShown')) {
        setTimeout(() => {
            if (window.location.href.includes('alltrails.com')) {
                console.log(`
╔════════════════════════════════════════════════════════════════════════════════╗
║                                                                                ║
║  🚀 ${SCRIPT_NAME} v${VERSION}                                                ║
║                                                                                ║
║  Bulk downloader for AllTrails GPX files                                       ║
║  with anti-bot protection and CAPTCHA detection                                ║
║                                                                                ║
║  📖 HOW TO USE:                                                                ║
║  1. Go to https://www.alltrails.com/members/your-username/recordings           ║
║  2. Use the floating control panel (top-left)                                  ║
║  3. Click "1. Discover URLs" then "2. Download GPX+JSON"                       ║
║                                                                                ║
║  🛡️ FEATURES:                                                                  ║
║  • Human-like behavior simulation                                              ║
║  • CAPTCHA detection and handling                                              ║
║  • Rate limit detection with smart retry                                       ║
║  • JSON metadata extraction                                                    ║
║  • Progress tracking and recovery                                              ║
║                                                                                ║
║  💡 TIP: Enable "Human-like behavior" for best results                         ║
║                                                                                ║
║  🐛 Issues: https://nebriv/AllTrails-DataExporter                              ║
║                                                                                ║
╚════════════════════════════════════════════════════════════════════════════════╝
                `);
                state.set('welcomeShown', true);
            }
        }, 2000);
    }

    // Expose useful functions to global scope for debugging
    if (CONFIG.debugMode) {
        window.AllTrailsDownloader = {
            version: VERSION,
            state: state,
            config: CONFIG,
            log: log,
            startDiscovery: startDiscovery,
            startDownload: startDownload,
            stopAll: stopAll,
            showProgress: showDetailedProgress,
            exportUrls: exportRemainingUrls,
            importUrls: importUrls
        };
    }

})();
