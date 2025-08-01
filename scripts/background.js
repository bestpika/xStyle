var frameIdMessageable;
var autoUpdateTimer = null;

async function appId() {
	let { appUniqueId } = await browser.storage.local.get("appUniqueId");
	if (appUniqueId) {
		return appUniqueId;
	}
	appUniqueId = "xxxxxxxx-xxxx-8xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (a) => {
		var c = 16 * Math.random() | 0;
		return ("x" == a ? c : 3 & c | 8).toString(16)
	});
	await browser.storage.local.set({ appUniqueId });
	return appUniqueId;
}

runTryCatch(() => {
	browser.tabs.sendMessage(0, {}, {frameId: 0}).then(() => {
		frameIdMessageable = true;
	});
});

// This happens right away, sometimes so fast that the content script isn't even ready. That's
// why the content script also asks for this stuff.
browser.webNavigation.onCommitted.addListener(webNavigationListener.bind(this, "styleApply"));
// Not supported in Firefox - https://bugzilla.mozilla.org/show_bug.cgi?id=1239349
if ("onHistoryStateUpdated" in browser.webNavigation) {
	browser.webNavigation.onHistoryStateUpdated.addListener(webNavigationListener.bind(this, "styleReplaceAll"));
}

browser.webNavigation.onBeforeNavigate.addListener(webNavigationListener.bind(this, null));
function webNavigationListener(method, data) {
	// Until Chrome 41, we can't target a frame with a message
	// (https://developer.chrome.com/extensions/tabs#method-sendMessage)
	// so a style affecting a page with an iframe will affect the main page as well.
	// Skip doing this for frames in pre-41 to prevent page flicker.
	if (data.frameId != 0 && !frameIdMessageable) {
		return;
	}
	getStyles({matchUrl: data.url, enabled: true, asHash: true}).then((styleHash) => {
		if (method) {
			browser.tabs.sendMessage(data.tabId, {method: method, styles: styleHash}, frameIdMessageable ? {frameId: data.frameId} : undefined);
		}
		if (data.frameId == 0) {
			updateIcon({id: data.tabId, url: data.url}, styleHash);
		}
	});
}

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.method === 'notifyBackground') {
		request.method = request.reason;
	}
	switch (request.method) {
		case "getStyles":
			// check if this is a main content frame style enumeration
			getStyles(request).then((styles) => {
				if (request.matchUrl && !request.id && sender && sender.tab && sender.frameId == 0 && sender.tab.url == request.matchUrl) {
					updateIcon(sender.tab, styles);
				}
				sendResponse(styles);
			});
			return true;
		case "saveStyle":
			saveStyle(request).then(sendResponse);
			return true;
		case "installStyle":
			installStyle(request).then(sendResponse);
			return true;
		case "invalidateCache":
			if (typeof invalidateCache != "undefined") {
				invalidateCache(false);
			}
			break;
		case "healthCheck":
			getDatabase().then(() => {
				sendResponse(true);
			}).catch(() => {
				sendResponse(false);
			});
			return true;
		case "openURL":
			openURL(request, sendResponse);
			return true;
		case "styleDisableAll":
			browser.contextMenus.update("disableAll", {checked: request.disableAll});
			break;
		case "GhostText":
			GTOnMessage(request, sender).then(sendResponse);
			return true;
		case "prefChanged":
			switch (request.prefName) {
				case "show-badge":
					browser.contextMenus.update("show-badge", {checked: request.value});
					break;
				case "auto-update":
					toggleAutoUpdate(request.value);
					break;
			}
			break;
		case "prefGet":
			if (typeof(request.name) === 'string') {
				sendResponse(prefs.get(request.name));
			} else {
				let result = [];
				request.name.forEach(n => result.push(prefs.get(n)));
				sendResponse(request);
			}
			break;
	}
	sendResponse(); // avoid error
});


if (IS_MOBILE) {
	browser.browserAction.onClicked.addListener(() => {
		openURL({url: browser.extension.getURL('manage.html')});
	});
} else {
	// contextMenus API is present in ancient Chrome but it throws an exception
	// upon encountering the unsupported parameter value "browser_action", so we have to catch it.
	runTryCatch(() => {
		browser.contextMenus.create({
			id: "openManage", title: browser.i18n.getMessage("openManage"),
			type: "normal", contexts: ["browser_action"]
		}, () => { var clearError = browser.runtime.lastError });
		browser.contextMenus.create({
			id: "show-badge", title: browser.i18n.getMessage("menuShowBadge"),
			type: "checkbox", contexts: ["browser_action"], checked: prefs.get("show-badge")
		}, () => { var clearError = browser.runtime.lastError });
		browser.contextMenus.create({
			id: "disableAll", title: browser.i18n.getMessage("disableAllStyles"),
			type: "checkbox", contexts: ["browser_action"], checked: prefs.get("disableAll")
		}, () => { var clearError = browser.runtime.lastError });
	});

	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (info.menuItemId === 'openManage') {
			openURL({"url": browser.extension.getURL("manage.html")});
		} else if (info.menuItemId === "disableAll") {
			disableAllStylesToggle(info.checked);
		} else {
			prefs.set(info.menuItemId, info.checked);
		}
	});
	// commands
	browser.commands.onCommand.addListener((command) => {
		switch (command) {
			case 'openManage':
				openURL({"url": browser.extension.getURL("manage.html")});
				break;
			case 'styleDisableAll':
				disableAllStylesToggle();
				break;
			default:
				break;
		}
	});
}

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
	if (info.status == "loading" && info.url) {
		if (canStyle(info.url)) {
			webNavigationListener("styleReplaceAll", {tabId: tabId, frameId: 0, url: info.url});
		} else {
			updateIcon(tab);
		}
	}
});

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
	browser.tabs.get(addedTabId).then((tab) => {
		webNavigationListener("getStyles", {tabId: addedTabId, frameId: 0, url: tab.url});
	});
});

browser.tabs.onCreated.addListener((tab) => {
	updateIcon(tab);
});

function disableAllStylesToggle(newState) {
	if (newState === undefined || newState === null) {
		newState = !prefs.get("disableAll");
	}
	prefs.set("disableAll", newState);
}

// enable/disable auto update
function toggleAutoUpdate(e) {
	if (autoUpdateTimer === null && e) {
		autoUpdateStyles();
		autoUpdateTimer = setInterval(autoUpdateStyles, 4 * 60 * 60 * 1000); // 4 hours
	}
	if (autoUpdateTimer !== null && !e) {
		clearInterval(autoUpdateTimer);
		autoUpdateTimer = null;
	}
}
function autoUpdateStyles() {
	getStyles({}).then((styles) => {
		for (let style of styles) {
			if (!style.url || !style.autoUpdate) {
				continue;
			} else if (!style.md5Url || !style.originalMd5) {
				updateStyleFullCode(style);
			} else {
				checkStyleUpdateMd5(style).then((needsUpdate) => {
					if (needsUpdate) {
						updateStyleFullCode(style);
					}
				});
			}
		}
	});
}

function openURL(options, sendResponse) {
	delete options.method;
	browser.tabs.query({currentWindow: true, url: options.url}).then((tabs) => {
		if (tabs.length) {
			browser.tabs.update(tabs[0].id, {
				"active": true
			}).then(sendResponse);
		} else {
			getActiveTab((tab) => {
				// re-use an active new tab page
				// Firefox may have more than 1 newtab url, so check all
				const isNewTab = tab.url.indexOf('about:newtab') === 0 || tab.url.indexOf('about:home') === 0 || tab.url.indexOf('chrome://newtab/') === 0;
				browser.tabs[isNewTab ? "update" : "create"](options).then(sendResponse);
			});
		}
	});
}


function requestUserPrefs() {
	let t = setTimeout(() => {
		clearTimeout(t);
		if (!prefs.isDefault) {
			if (!IS_MOBILE) {
				['disableAll', 'show-badge'].forEach((k) => {
					browser.contextMenus.update(k, {"checked": prefs.get(k)});
				});
			}
			toggleAutoUpdate(prefs.get('auto-update'));
		} else {
			requestUserPrefs();
		}
	}, 10);
}
requestUserPrefs();
export {};