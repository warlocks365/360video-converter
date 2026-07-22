// JavaScript syntax validation for index.html script blocks
const fs = require('fs');
const code = fs.readFileSync('static/index.html', 'utf8');
const scriptMatches = code.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
let errors = 0;
scriptMatches.forEach((s, i) => {
    const body = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    if (!body.trim()) return;
    try {
        new Function(body);
    } catch(e) {
        console.log('Script block ' + i + ' error: ' + e.message);
        errors++;
    }
});
if (errors === 0) console.log('All script blocks OK (' + scriptMatches.length + ' blocks)');
else console.log(errors + ' script block(s) with errors');
