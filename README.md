![Created with Generative AI](https://img.shields.io/badge/⚠️_Created_with_Generative_AI-orange?style=flat)

# AllTrails Data Exporter

A userscript to bulk download GPX files from your AllTrails recordings. Useful for backing up your data or migrating away from AllTrails.

## ⚠️ Warning ⚠️

**Using this script may violate AllTrails Terms of Service and could result in:**
- IP address blocks
- Account termination 
- Loss of your data

**You are strongly encouraged to first request your personal data officially:**
https://support.alltrails.com/hc/en-us/articles/18177547076116-How-to-request-a-copy-of-your-AllTrails-account-data

**AllTrails failed to respond to my personal data request in a timely manner, forcing the creation of this script to migrate off the platform.**

## Alternatives

Before using this script, consider:
1. **Official data request** (link above) - Wait 30+ days for response
2. **Manual export** - Download files individually (time-consuming)
3. **This script** - Automated but with ToS risks

## Why This Exists

AllTrails has been making it increasingly difficult to export your own data, and like many platforms, seems to be heading down the path of vendor lock-in. This script helps you get your GPX files and metadata out while you still can.

AllTrails failed to reply to my personal data request in a timely manner, resulting in the creation of this script so I could migrate off the platform.

## Features

- Bulk download all your AllTrails recordings as GPX files
- Save activity metadata as JSON (stats, photos, reviews, etc.)
- Human-like behavior to avoid triggering anti-bot measures
- CAPTCHA detection and handling
- Rate limit detection with smart retry logic
- Import/export URL lists for batch processing
- Progress tracking and auto-recovery

## Installation

1. **Install a userscript manager:**
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Safari, Edge)
   - [Greasemonkey](https://www.greasespot.net/) (Firefox)

2. **Install the script:**
   - Click here to install: [alltrails-data-exporter.user.js](https://github.com/nebriv/AllTrails-DataExporter/raw/main/alltrails-data-exporter.user.js)
   - Or copy the script contents and create a new userscript manually

3. **The script will auto-update when you visit AllTrails**

## Usage

> **Recommendation:** Use a VPN to avoid getting your IP address blocked.

1. **Go to your AllTrails recordings page:**
   ```
   https://www.alltrails.com/members/your-username/recordings
   ```

2. **Use the control panel** (appears in the top-left corner):
   - Click **"1. Discover URLs"** to find all your recordings
   - Click **"2. Download GPX+JSON"** to start downloading
   - Or use **"Import"** to load a specific list of URLs

3. **Configure options** (recommended):
   - ✅ Enable "Human-like behavior" for better success rate
   - ✅ Enable "Save review data as JSON" to backup metadata

4. **Let it run:**
   - The script will automatically navigate between recordings
   - Downloads will appear in your browser's download folder
   - Progress is tracked and can be resumed if interrupted

## Configuration

Edit these settings in the script if needed:

```javascript
const CONFIG = {
    downloadDelay: {
        min: 90000,    // 1.5 minutes between downloads
        max: 185000    // ~3 minutes between downloads
    },
    saveReviewData: true,        // Save JSON metadata
    humanLikeBehavior: true,     // Anti-bot protection
    // ... etc
};
```

## Troubleshooting

**Rate Limited:**
- Script automatically handles this by moving to the next file
- Rate-limited files are retried later in the queue
- Use the "Reset Rate Limit Mode" button if needed

**CAPTCHA Appears:**
- Complete the CAPTCHA manually
- Click "Resume" in the notification
- Script will continue from where it left off

**Script Gets Stuck:**
- Click the "Recover" button
- Or refresh the page and click "Resume"

**No Downloads Starting:**
- Make sure you're on the recordings page
- Check that pop-ups aren't blocked
- Try disabling other browser extensions temporarily

## File Formats

**GPX Files:**
- Standard GPS exchange format
- Compatible with most mapping/GPS software
- Named: `route_[timestamp].gpx`

**JSON Files:**
- Contains trail metadata, stats, photos, reviews
- Named: `alltrails_[trail_name]_[date]_[id].json`

## Technical Details

- Uses delays (1.5-3 minutes between downloads)
- Randomized clicking and scrolling patterns
- Monitors for rate limits and CAPTCHAs
- Automatically retries failed downloads
- Stores progress in browser session storage

## Limitations

- Only works with your own AllTrails recordings
- Requires manual CAPTCHA solving if triggered
- Download speed limited to avoid getting blocked
- Some recordings may fail due to AllTrails changes
- The entire script may fail due to AllTrails site updates

## Contributing

Feel free to open issues or submit pull requests. This is a community tool to help people maintain access to their *own* data.

## Legal

This script only downloads data from your own AllTrails account. Users are responsible for complying with AllTrails' Terms of Service and applicable laws.

## License

MIT License - see LICENSE file for details.