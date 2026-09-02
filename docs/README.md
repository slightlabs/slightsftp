# SLightSFTP Documentation

This directory contains the GitHub Pages website for SLightSFTP.

## Structure

- `index.html` - Main landing page
- `css/styles.css` - Styling for all pages
- `features.html` - Detailed features guide
- `configuration.html` - Configuration documentation
- `api.html` - API reference for developers
- `troubleshooting.html` - Common issues and solutions
- `404.html` - Custom 404 error page
- `images/` - Directory for images and screenshots
- `README.md` - This file

## Deployment

This site is designed to be deployed via GitHub Pages from the `/docs` folder.

### GitHub Pages Setup

1. Go to your repository Settings
2. Navigate to Pages
3. Select "Source" → "Deploy from a branch"
4. Choose branch: `main` (or your default branch)
5. Choose folder: `/docs`
6. Click Save

Your site will be available at: `https://yourusername.github.io/slightsftp`

## Local Development

To test the site locally:

```bash
# Using Python
cd docs
python -m http.server 8000

# Using Node.js
npx serve docs

# Using PHP
php -S localhost:8000
```

Then visit `http://localhost:8000` in your browser.

## Customization

- Update colors and styling in `css/styles.css`
- Add screenshots to the `images/` folder
- Modify content in the HTML files
- Update GitHub links to match your repository