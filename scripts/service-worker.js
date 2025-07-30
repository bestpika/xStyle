try {
    importScripts(
        './browser-polyfill.js',
        './common.js',
        './messaging.js',
        './userstyle.js',
        './storage.js',
        './GhostText.js',
        './background.js'
    );
} catch (e) {
    console.error(e);
}

const userstylesRule = {
    "id": 1,
    "priority": 1,
    "action": {
        "type": "modifyHeaders",
        "requestHeaders": [
            { "header": "Referer", "operation": "set", "value": "https://userstyles.org/" }
        ]
    },
    "condition": {
        "urlFilter": "*://userstyles.org/*",
        "resourceTypes": ["main_frame", "sub_frame", "stylesheet", "script", "image", "object", "xmlhttprequest", "other"]
    }
};

const cspRule = {
    "id": 2,
    "priority": 1,
    "action": {
        "type": "modifyHeaders",
        "responseHeaders": [
            { "header": "Content-Security-Policy", "operation": "append", "value": "style-src 'unsafe-inline'" }
        ]
    },
    "condition": {
        "urlFilter": "*://*/*",
        "resourceTypes": ["main_frame", "sub_frame"]
    }
};

async function updateRules() {
    const { 'modify-csp': modifyCsp } = await browser.storage.local.get('modify-csp');

    const rules = [userstylesRule];
    if (modifyCsp) {
        rules.push(cspRule);
    }

    const oldRules = await chrome.declarativeNetRequest.getDynamicRules();
    const oldRuleIds = oldRules.map(rule => rule.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: oldRuleIds,
        addRules: rules
    });
}

// Update rules when the extension starts
updateRules();

// Update rules when the preference changes
browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['modify-csp']) {
        updateRules();
    }
});
