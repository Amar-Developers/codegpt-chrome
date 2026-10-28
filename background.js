// Code GPT for Chrome - background: side panel, right-click menu, sign-in and the stop shortcut.
const DEFAULT_BASE = 'https://chat.codegpt.it.com';
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener((info) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cg', title: 'Code GPT', contexts: ['selection', 'page', 'editable'] });
    const items = [
      ['explain', 'Explain this', ['selection']],
      ['summarize', 'Summarise', ['selection']],
      ['translate', 'Translate to English', ['selection']],
      ['improve', 'Improve this writing', ['selection', 'editable']],
      ['reply', 'Write a reply to this', ['selection']],
      ['page', 'Summarise this page', ['page']],
      ['ask', 'Ask about this…', ['selection', 'page']]
    ];
    for (const [id, title, contexts] of items) chrome.contextMenus.create({ id, parentId: 'cg', title, contexts });
  });
  if (info.reason === 'install') chrome.tabs.create({ url: DEFAULT_BASE + '/connect?client=chrome' });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // open first (must happen right after the click), then hand over the job
  if (tab && tab.id >= 0) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  chrome.storage.session.set({ pending: { action: info.menuItemId, selection: (info.selectionText || '').slice(0, 20000),
    tabId: tab ? tab.id : null, url: tab ? tab.url : '', title: tab ? tab.title : '', at: Date.now() } });
});

// Alt+Shift+S: tell the open side panel to stop the agent.
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === 'stop_agent') chrome.runtime.sendMessage({ type: 'cga-stop' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'cg-connect' && sender.url && sender.url.startsWith(DEFAULT_BASE + '/connect')
      && /^cgx_[\w-]{20,}$/.test(msg.token || '')) {
    chrome.storage.local.set({ token: msg.token, base: DEFAULT_BASE }, () => reply({ ok: true }));
    return true;
  }
});
