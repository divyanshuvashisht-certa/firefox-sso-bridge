const list = document.querySelector('#containers');
const form = document.querySelector('#create');
const error = document.querySelector('#error');
const message = (payload) => browser.runtime.sendMessage(payload);
function showError(text = '') { error.textContent = text; }
document.querySelectorAll('.color-swatch').forEach((swatch) => {
  swatch.onclick = () => {
    document.querySelector('#color').value = swatch.dataset.color;
    document.querySelectorAll('.color-swatch').forEach((item) => {
      const selected = item === swatch;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
  };
});
async function refresh() {
  const containers = await message({ type: 'containers' });
  list.replaceChildren();
  if (!containers.length) { const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = 'No client containers yet.'; list.append(empty); return; }
  for (const container of containers) {
    const item = document.createElement('li'); item.className = 'container';
    const dot = document.createElement('span'); dot.className = `dot ${container.color}`;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = container.name;
    const open = document.createElement('button'); open.className = 'open'; open.textContent = 'Open';
    open.onclick = () => message({ type: 'open-container', cookieStoreId: container.cookieStoreId }).catch((cause) => showError(cause.message));
    const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×'; remove.title = 'Remove container'; remove.setAttribute('aria-label', `Remove ${container.name}`);
    remove.onclick = async () => { if (!confirm(`Remove “${container.name}”? This closes its tabs and clears its isolated session data.`)) return; try { await message({ type: 'remove-container', cookieStoreId: container.cookieStoreId }); await refresh(); } catch (cause) { showError(cause.message); } };
    item.append(dot, name, open, remove); list.append(item);
  }
}
form.onsubmit = async (event) => { event.preventDefault(); showError(); try { const container = await message({ type: 'create-container', name: document.querySelector('#name').value, color: document.querySelector('#color').value }); form.reset(); document.querySelector('.color-swatch.blue').click(); await message({ type: 'open-container', cookieStoreId: container.cookieStoreId }); await refresh(); } catch (cause) { showError(cause.message); } };
refresh().catch((cause) => showError(cause.message));
