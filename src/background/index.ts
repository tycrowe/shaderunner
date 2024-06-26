import defaults from "~defaults";
import { Storage } from "@plasmohq/storage"
import { getData, notifyListeners, registerListener } from "~background/tabData";
import { db } from "~db";
const storage = new Storage()

const DEV = process.env.NODE_ENV == "development";


// clear old embedding stores from db
async function autoDeleteOldStores() {
    await db.deleteOldEmbeddings();
    setInterval(async () => {
        await db.deleteOldEmbeddings();
    }, 6 * 60 * 60 * 1000); // 6 hours in milliseconds
}
autoDeleteOldStores();


const tabUpdated = tabId => {
    chrome.tabs.get(tabId, async function(tab) {
        await chrome.sidePanel.setOptions({
            tabId,
            path: 'sidepanel.html?tabId='+tab.id
        });
    });
}

// on tab change, update the sidepanel url
chrome.tabs.onActivated.addListener(activeInfo => tabUpdated(activeInfo.tabId))
chrome.tabs.onUpdated.addListener(tabUpdated)

// on startup, set sidepanel
chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
    if (tabs.length == 0) return;
    tabUpdated(tabs[0].id)
});





// toggle sidePanel
chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.url) return;
    const active = getData(tab.id, ["active"]).active;
    if (!active)
        await chrome.sidePanel.open({windowId: tab.windowId});
    else if (active) {
        await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false });
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html?tabId='+tab.id, enabled: true });
    }
})

// toggle active status when sidePanel is opened/closed
chrome.runtime.onConnect.addListener(function (port) {
    if (port.name.startsWith('shaderunnerSidePanel_tabId=')) {
        const tabId = Number(port.name.split("=")[1]);
        notifyListeners(tabId, {active: true})
        port.onDisconnect.addListener(() => notifyListeners(tabId, {active: false}));
    }
});


// ensure settinngs exist upon installation
chrome.runtime.onInstalled.addListener(async (details) => {

    // overwrite defaults
    if (details.reason === 'install' || details.reason === 'update') {
        if (process.env.NODE_ENV == "development") return;
        console.log("Setting default settings.");
        Object.entries(defaults).forEach(async (v, i) => {
            const [key, value] = v;
            return (await storage.set(key, value));
        })
    } 
    if (details.reason === 'update') {
        console.log("Update! Settings set to default.");
    }
});


// add context menu "open side panel" / "open testing page"
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: 'openSidePanel',
        title: 'Open side panel',
        contexts: ['all']
    });
    if (DEV)
    chrome.contextMenus.create({
        id: 'openTestingPage',
        title: 'Open testing page',
        contexts: ['all']
    });
});


// open side panel when context menu is clicked
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'openSidePanel') {
        chrome.sidePanel.open({ windowId: tab.windowId });
    }
});


// open side panel when context menu is clicked
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'openTestingPage') {
        const url = chrome.runtime.getURL("/tabs/testing.html")
        chrome.tabs.create({
            url: url
       });
    }
});


// ======== //
// messages //
// ======== //

// tell content script about tabId
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse){
    if (msg == "get_tabid")
        sendResponse(sender.tab.id)
});

// register components
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse){
    if (msg.action == "storage_listener_register")
        registerListener(msg.tabId, msg.variables, msg.listenerId);
});

// notify components on a change
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse){
    if (msg.action == "storage_variable_changed")
        notifyListeners(msg.tabId, msg.update);
});
