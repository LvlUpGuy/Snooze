/*
 * The Great Suspender
 * Copyright (C) 2014 Dean Oemcke
 * Available under GNU GENERAL PUBLIC LICENSE v2
 * http://github.com/deanoemcke/thegreatsuspender
 * ༼ つ ◕_◕ ༽つ
*/
// A LOT of these are just work-arounds for a big refactoring which I'll do
// later. TODO fix the order of the functions
/*global gsUtils, gsTimes, chrome, requestTabSuspension, requestTabUnsuspend, checkForSuspendedTab, updateTabStatus, updateIcon, requestTabInfo, handleNewTabFocus, runStartupChecks, reinjectContentScripts, getTabInfo */

var tgs = (function () {

    'use strict';

    var debug = false,
        sessionId = gsUtils.generateSessionId(),
        //sessionDate = new Date(),
        lastSelectedTabs = [],
        currentTabId;

    function checkWhiteList(url) {
        var whitelist = gsUtils.getOption(gsUtils.WHITELIST),
            whitelistedWords = whitelist ? whitelist.split(/[\s\n]+/) : '';

        whitelistedWords.forEach(function (word) {
            if (word.length > 0 && url.indexOf(word) >= 0) {
                return true;
            }
        });
        return false;
    }

    function saveSuspendData(tab, previewUrl) {
        var gsHistory = gsUtils.fetchGsHistory(),
            tabProperties,
            //rootUrl = gsUtils.getRootUrl(tab.url), // unused
            favUrl;

        //console.log('attempting to suspend: ' + tab.url);
        if (previewUrl) {
            gsUtils.setPreviewImage(tab.url, previewUrl);
        }

        if (tab.incognito) {
            favUrl = tab.favIconUrl;
        } else {
            favUrl = 'chrome://favicon/' + tab.url;
        }

        tabProperties = {
            date: new Date(),
            title: tab.title,
            url: tab.url,
            favicon: favUrl,
            pinned: tab.pinned,
            index: tab.index,
            windowId: tab.windowId
        };

        //add suspend information to start of history array
        gsHistory.unshift(tabProperties);

        //clean up old items
        //TODO use splice or something here, this is resource wasteful
        while (gsHistory.length > 100) {
            gsHistory.pop();
        }
        gsUtils.setGsHistory(gsHistory);
    }

    function isSpecialTab(tab) {

        if ((tab.url.indexOf('chrome-extension:') === 0
                && tab.url.indexOf('suspended.html') < 0)
                || tab.url.indexOf('chrome:') === 0
                || tab.url.indexOf('chrome-devtools:') === 0
                || tab.url.indexOf('file:') === 0
                || tab.url.indexOf('chrome.google.com/webstore') >= 0) {
            return true;
        }
        return false;
    }

    function isPinnedTab(tab) {
        var dontSuspendPinned = gsUtils.getOption(gsUtils.IGNORE_PINNED);
        return dontSuspendPinned && tab.pinned;
    }

    function isExcluded(tab) {
        if (tab.active) {
            return true;
        }

        //don't allow suspending of special tabs
        if (isSpecialTab(tab)) {
            return true;
        }

        //check whitelist
        if (checkWhiteList(tab.url)) {
            return true;
        }

        if (isPinnedTab(tab)) {
            return true;
        }
        return false; //TODO make sure this doesn't break anything
    }

    function whitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                var rootUrlStr = gsUtils.getRootUrl(tabs[0].url);
                gsUtils.saveToWhitelist(rootUrlStr);
                requestTabUnsuspend(tabs[0]);
            }
        });
    }

    function unwhitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                var rootUrlStr = gsUtils.getRootUrl(tabs[0].url);
                gsUtils.removeFromWhitelist(rootUrlStr);
            }
        });
    }

    function temporarilyWhitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, {action: 'tempWhitelist'});
            }
        });
    }

    function undoTemporarilyWhitelistHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, {action: 'undoTempWhitelist'});
            }
        });
    }

    function suspendHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                requestTabSuspension(tabs[0], true);
            }
        });
    }

    function unsuspendHighlightedTab(window) {
        chrome.tabs.query({windowId: window.id, highlighted: true}, function (tabs) {
            if (tabs.length > 0) {
                requestTabUnsuspend(tabs[0]);
            }
        });
    }

    function suspendAllTabs(window) {
        window.tabs.forEach(function (tab) {
            requestTabSuspension(tab);
        });
    }

    function unsuspendAllTabs(curWindow) {
        var //tabProperties, // unused
            responsiveTabs = [],
            tabResponses = {};

        curWindow.tabs.forEach(function (currentTab) {
            //detect suspended tabs by looking for ones without content scripts
            if (!isSpecialTab(currentTab)) {
                responsiveTabs.push(currentTab);

                checkForSuspendedTab(currentTab, function (isSuspended) {
                    tabResponses[currentTab.id] = true;

                    if (isSuspended) {
                        requestTabUnsuspend(currentTab);
                    }
                });
            }
        });

        //handle any other tabs that didn't respond for whatever reason (usually because the tab has crashed)
        setTimeout(function () {
            responsiveTabs.forEach(function (curTab) {
                if (tabResponses[curTab.id] === 'undefined') {
                    requestTabUnsuspend(curTab);
                }
            });
        }, 5000);
    }

    function checkForSuspendedTab(tab, callback) {
        var tidyUrls = gsUtils.getOption(gsUtils.TIDY_URLS);

        if (tidyUrls) {
            //test if a content script is active by sending a 'requestInfo' message
            chrome.tabs.sendMessage(tab.id, {action: 'requestInfo'}, function (response) {

                //if response is given but is undefined, then assume suspended
                if (response === 'undefined') {
                    callback(true);
                } else {
                    callback(false);
                }
            });
        } else {
            if (tab.url.indexOf('suspended.html') >= 0) {
                callback(true);
            } else {
                callback(false);
            }
        }
    }

    function saveWindowHistory() {
        chrome.windows.getAll({populate: true}, function (windows) {
            gsUtils.saveWindowsToSessionHistory(sessionId, windows);
        });
    }

    //add an initial time to all open tabs
    function initialiseAllTabs() {
        chrome.tabs.query({}, function (tabs) {
            tabs.forEach(function (tab) {
                gsTimes[tab.id] = new Date();
            });
        });
    }

    function resetTabTimer(tabId) {
        var timeout = gsUtils.getOption(gsUtils.SUSPEND_TIME) * 60 * 1000;
        chrome.tabs.sendMessage(tabId, {action: 'resetTimer', timeout: timeout});
    }

    function cancelTabTimer(tabId) {
        chrome.tabs.sendMessage(tabId, {action: 'cancelTimer'});
    }

    function requestTabSuspension(tab, force) {
        force = force || false;

        //check whitelist
        if (!force && isExcluded(tab)) {
            return;
        }
        //check internet connectivity
        if (!force && gsUtils.getOption(gsUtils.ONLINE_CHECK) && !navigator.onLine) {
            return;
        }
        //if we need to save a preview image
        if (gsUtils.getOption(gsUtils.SHOW_PREVIEW)) {
            chrome.tabs.executeScript(tab.id, {file: 'html2canvas.min.js'}, function () {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'generatePreview',
                    suspendedUrl: gsUtils.generateSuspendedUrl(tab.url)
                });
            });

        //else ask the tab to suspend itself
        } else {
            saveSuspendData(tab);
            chrome.tabs.sendMessage(tab.id, {
                action: 'confirmTabSuspend',
                suspendedUrl: gsUtils.generateSuspendedUrl(tab.url)
            });
        }
    }

    function requestTabUnsuspend(tab) {
        var tidyUrls = gsUtils.getOption(gsUtils.TIDY_URLS),
            url;

        if (tidyUrls) {
            chrome.tabs.reload(tab.id);
        } else {
            url = gsUtils.getHashVariable('url', tab.url.split('suspended.html')[1]);
            chrome.tabs.update(tab.id, {url: url});
        }
    }

    function unsuspendTab(tab) {
        var tidyUrls = gsUtils.getOption(gsUtils.TIDY_URLS),
            url;

        if (tidyUrls) {
            chrome.tabs.reload(tab.id);
        } else {
            url = gsUtils.getHashVariable('url', tab.url.split('suspended.html')[1]);
            chrome.tabs.update(tab.id, {url: url});
        }
    }


    function suspendAllTabsOnStartup() {
        chrome.tabs.query({}, function (tabs) {
            tabs.forEach(function (tab) {
                if (!isSpecialTab(tab) && gsUtils.fetchTabFromHistory(tab.url)) {
                    requestTabSuspension(tab, true);
                }
            });
        });

        //TODO should use declaritiveWebRequest here once it becomes stable
        /*
        chrome.webRequest.onBeforeRequest.addListener(
            function (details) {
                var args = '#url=' + encodeURIComponent(details.url);
                return {
                    redirectUrl: gsUtils.generateSuspendedUrl(chrome.extension.getURL('suspended.html' + args))
                };
            },
            {urls: ["<all_urls>"]},
            ["blocking"]
        );
        */
    }

    //handler for message requests
    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (debug) {
            console.log('listener fired:', request.action);
            console.dir(sender);
        }

        //TODO switch statement
        //treat this as a handler for initial page load (called by content script on page load)
        if (request.action === 'prefs') {
            sendResponse({
                dontSuspendForms: gsUtils.getOption(gsUtils.IGNORE_FORMS),
                showPreview: gsUtils.getOption(gsUtils.SHOW_PREVIEW),
                suspendTime: gsUtils.getOption(gsUtils.SUSPEND_TIME),
                previewQuality: gsUtils.getOption(gsUtils.PREVIEW_QUALITY) ? 0.8 : 0.1
            });

        } else if (request.action === 'reportTabState') {
            if (sender.tab && sender.tab.id === currentTabId) {
                var status = updateTabStatus(sender.tab, request.status);
                updateIcon(status);
            }

        } else if (request.action === 'confirmTabUnsuspend') {
            unsuspendTab(sender.tab);

        } else if (request.action === 'suspendTab') {
            requestTabSuspension(sender.tab);

        } else if (request.action === 'savePreviewData') {
            saveSuspendData(sender.tab, request.previewUrl);

        } else if (request.action === 'suspendOne') {
            chrome.windows.getLastFocused({populate: true}, suspendHighlightedTab);

        } else if (request.action === 'unsuspendOne') {
            chrome.windows.getLastFocused({populate: true}, unsuspendHighlightedTab);

        } else if (request.action === 'tempWhitelist') {
            chrome.windows.getLastFocused({populate: true}, temporarilyWhitelistHighlightedTab);

        } else if (request.action === 'undoTempWhitelist') {
            chrome.windows.getLastFocused({populate: true}, undoTemporarilyWhitelistHighlightedTab);

        } else if (request.action === 'whitelist') {
            chrome.windows.getLastFocused({populate: true}, whitelistHighlightedTab);

        } else if (request.action === 'removeWhitelist') {
            chrome.windows.getLastFocused({populate: true}, unwhitelistHighlightedTab);

        } else if (request.action === 'suspendAll') {
            chrome.windows.getLastFocused({populate: true}, suspendAllTabs);

        } else if (request.action === 'unsuspendAll') {
            chrome.windows.getLastFocused({populate: true}, unsuspendAllTabs);
        }
    });

    //listen for tab create
    /*
    chrome.tabs.onCreated.addListener(function (tab) {
        if (debug) {
            console.log('tab created: ' + tab.url);
        }
    });
    */

    //listen for tab remove
    /*
    chrome.tabs.onRemoved.addListener(function (tabId, removeInfo) {
        if (debug) {
            console.log('tab removed: ' + tabId);
        }
    });
    */

    //listen for tab switching
    chrome.tabs.onActivated.addListener(function (activeInfo) {
        if (debug) {
            console.log('tab changed: ' + activeInfo.tabId);
        }

        var lastSelectedTab = lastSelectedTabs[activeInfo.windowId];

        lastSelectedTabs[activeInfo.windowId] = activeInfo.tabId;
        currentTabId = activeInfo.tabId;

        //reset timer on tab that lost focus
        if (lastSelectedTab) {
            resetTabTimer(lastSelectedTab);
        }

        //update icon
        requestTabInfo(activeInfo.tabId, function (info) {
            updateIcon(info.status);
        });


        //pause for a bit before assuming we're on a new tab as some users
        //will key through intermediate tabs to get to the one they want.
        (function () {
            var selectedTab = activeInfo.tabId;
            setTimeout(function () {
                if (selectedTab === currentTabId) {
                    handleNewTabFocus(currentTabId);
                }
            }, 500);
        }());
    });

    function handleNewTabFocus(tabId) {
        var unsuspend = gsUtils.getOption(gsUtils.UNSUSPEND_ON_FOCUS);

        //if pref is set, then unsuspend newly focused tab
        if (unsuspend) {
            //get tab object so we can check if it is a special tab
            //if not, then we test if the tab is suspended
            chrome.tabs.get(tabId, function (tab) {
                if (!isSpecialTab(tab)) {
                    checkForSuspendedTab(tab, function (isSuspended) {
                        if (isSuspended) {
                            requestTabUnsuspend(tab);
                        }
                    });
                }
            });
        }

        //clear timer on newly focused tab
        //NOTE: only works if tab is currently unsuspended
        cancelTabTimer(tabId);
    }

    function checkForCrashRecovery() {
        //attempt to automatically restore any lost tabs/windows in their proper positions
        var gsSessionHistory = gsUtils.fetchGsSessionHistory(),
            crashedSession,
            tabMap = {},
            windowsMap = {};

        if (gsSessionHistory.length > 0) {
            crashedSession = gsSessionHistory[0];

            chrome.windows.getAll({ populate: true }, function (windows) {
                windows.forEach(function (curWindow) {
                    curWindow.tabs.foreach(function (curTab) {
                        tabMap[curTab.id] = curTab;
                    });
                    windowsMap[curWindow.id] = tabMap;
                });

                crashedSession.windows.forEach(function (curWindow) {
                    //if crashed window exists in current session
                    if (windowsMap[curWindow.id]) {
                        tabMap = windowsMap[curWindow.id];

                        curWindow.tabs.forEach(function (curTab) {
                            //if current tab was suspended and does not exist then recreate it
                            if (!tabMap[curTab.id] && curTab.url.indexOf('suspended.html') > 0) {
                                chrome.tabs.create({
                                    windowId: curWindow.id,
                                    url: curTab.url,
                                    index: curTab.index,
                                    pinned: curTab.pinned,
                                    active: false
                                });
                            }
                        });
                    }
                });
            });
        }
    }


    //listen for tab updating
    //don't want to put a listener here as it's called too aggressively by chrome
    /*
    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (debug) {
            console.log('tab updated: ' + tabId);
        }

        //if tab does not have focus, then set timer on newly created tab
        if (!tab.active) {
            resetTabTimer(tab.id);
        }
    });
    */

    chrome.alarms.clearAll();
    chrome.alarms.create('saveWindowHistory', {periodInMinutes: 1});
    if (debug) {
        console.log('alarm created: saveWindowHistory');
    }

    chrome.alarms.onAlarm.addListener(function (alarm) {
        if (debug) {
            console.log('alarm fired: ' + alarm.name);
        }

        if (alarm.name === 'saveWindowHistory') {
            //chrome.browserAction.setBadgeText({text: "SAV"});
            console.log('saving current session. next save in 1 minute.');
            saveWindowHistory();
        }
    });

    chrome.runtime.onSuspend.addListener(function () {
        if (debug) {
            console.log('unloading page.');
            chrome.browserAction.setBadgeText({text: ''});
        }
    });

    chrome.commands.onCommand.addListener(function (command) {
        if (command === 'suspend-tab') {
            chrome.tabs.query({active: true}, function (tabs) {
                requestTabSuspension(tabs[0], true);
            });
        }
    });

    //careful. this seems to get called on extension reload as well as initial install
    chrome.runtime.onInstalled.addListener(function () {
        if (gsUtils.getSettings() === null) {
            gsUtils.initSettings(function () {
                runStartupChecks();
            });
        } else {
            runStartupChecks();
        }
    });

    function runStartupChecks() {
        var tidyUrls = gsUtils.getOption(gsUtils.TIDY_URLS),
            lastVersion = gsUtils.fetchVersion(),
            curVersion = chrome.runtime.getManifest().version;

        //check for possible crash
        if (!tidyUrls) {
            checkForCrashRecovery();
        }

        //if version has changed then assume initial install or upgrade
        if (lastVersion !== curVersion) {
            gsUtils.setVersion(curVersion);

            //if they are installing for the first time
            if (!lastVersion) {
                gsUtils.setGsHistory([]);

                //show welcome screen
                chrome.tabs.create({url: chrome.extension.getURL('welcome.html')});
            //else if they are upgrading to a new version
            } else {
                //if pre v5 then perform migration
                if (parseFloat(lastVersion) < 5) {
                    gsUtils.performMigration();
                }

                //show update screen
                chrome.tabs.create({url: chrome.extension.getURL('update.html')});
            }
        }

        //inject new content script into all open pages
        reinjectContentScripts();
    }

    function reinjectContentScripts() {
        chrome.tabs.query({}, function (tabs) {
            var timeout = gsUtils.getOption(gsUtils.SUSPEND_TIME) * 60 * 1000;

            tabs.forEach(function (currentTab) {
                if (!isSpecialTab(currentTab)) {
                    var tabId = currentTab.id;
                    //test if a content script is active by sending a 'requestInfo' message
                    chrome.tabs.sendMessage(tabId, {action: 'requestInfo'}, function (response) {
                        //if no response, then try to dynamically load in the new contentscript.js file
                        if (response === 'undefined') {
                            chrome.tabs.executeScript(tabId, {file: 'contentscript.js'}, function () {
                                chrome.tabs.sendMessage(tabId, {action: 'resetTimer', timeout: timeout});
                            });
                        }
                    });
                }
            });
        });
    }

    //get info for a tab. defaults to currentTab if no id passed in
    function requestTabInfo(tabId, callback) {
        tabId = tabId || currentTabId;

        chrome.tabs.get(tabId, function (tab) {
            getTabInfo(tab, function (info) {
                callback(info);
            });
        });
    }

    function getTabInfo(tab, callback) {
        var info = {
                tabId: tab.id,
                status: '',
                timerUp: '-'
            };

        if (isSpecialTab(tab)) {
            info.status = 'special';
            callback(info);
        } else {
            checkForSuspendedTab(tab, function (isSuspended) {
                if (isSuspended) {
                    info.status = 'suspended';
                    callback(info);
                } else {
                    chrome.tabs.sendMessage(tab.id, {action: 'requestInfo'}, function (response) {
                        info.status = response ? updateTabStatus(tab, response.status) : 'unknown';
                        info.timerUp = response ? response.timerUp : '?';
                        callback(info);
                    });
                }
            });
        }
    }

    function updateTabStatus(tab, reportedStatus) {
        if (checkWhiteList(tab.url)) {
            reportedStatus = 'whitelisted';
        } else if (reportedStatus === 'normal' && isPinnedTab(tab)) {
            reportedStatus = 'pinned';
        }
        return reportedStatus;
    }

    //change the icon to either active or inactive
    function updateIcon(status) {
        var icon = 'icon19.png',
            dontSuspendForms = gsUtils.getOption(gsUtils.IGNORE_FORMS),
            dontSuspendPinned = gsUtils.getOption(gsUtils.IGNORE_PINNED);

        if (status === 'suspended' || status === 'special') { icon = 'icon19b.png'; }
        /*
        if (status === 'formInput' || status === 'special' || status === 'pinned'
                || status === 'tempWhitelist' || status === 'whitelisted') {
            icon = 'icon19b.png';
        }
        */
        chrome.browserAction.setIcon({path: icon});

        if ((status === 'formInput' && dontSuspendForms)
                || (status === 'pinned' && dontSuspendPinned)
                || status === 'tempWhitelist'
                || status === 'whitelisted') {
            //chrome.browserAction.setBadgeBackgroundColor({color: '#777'});//#36BEF3'});
            //chrome.browserAction.setBadgeText({text: '!'});
            // TODO fill? JSLint complains of emptiness
        } else {
            chrome.browserAction.setBadgeText({text: ''});
        }
    }

    return {
        requestTabInfo: requestTabInfo,
        updateIcon: updateIcon,
        isSpecialTab: isSpecialTab
    };

}());
