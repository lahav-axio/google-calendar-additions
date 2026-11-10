window.onload = function () {

    const getDisabled = () => new Promise(res => chrome.storage.local.get('disabled', (s) => res(s.disabled)));
    const getStyle = () => new Promise(res => chrome.storage.local.get('style', (s) => res(s.style)));
    const getWildcard = () => new Promise(res => chrome.storage.local.get('wildcard', (s) => res(s.wildcard)));

    const setIcon = (disabled) => chrome.action.setIcon({
        path: disabled ? "icon-disabled.png" : "icon.png"
    });

    const setDropdown = (id, value) => {
        let element = document.getElementById(id);
        element.value = value;
    }

    const setToggle = (id, value) => {
        let element = document.getElementById(id);
        element.checked = value
    }

    const setText = (id, value) => {
        let element = document.getElementById(id);
        element.value = value
    }

    getDisabled().then(disabled => {
        if (disabled == null) {
            disabled = false
            chrome.storage.local.set({ 'disabled': disabled });
        }
        setToggle('toggle_enabled',!disabled)
    });
    getStyle().then(value => {
        if (value == null) {
            value = 'vertical_bands'
            chrome.storage.local.set({ 'style': value });
        }
        setDropdown('select_style',value)
    });

    getWildcard().then(value => {
        if (value == null) {
            value = 'busy'
            chrome.storage.local.set({ 'wildcard': value });
        }
        setText('wildcard_value',value)
    });

    // ---- "My calendar only" mode settings (added in this fork) ----
    const updateRows = mode => {
        document.querySelectorAll('.own-only').forEach(r => r.classList.toggle('hidden', mode !== 'own_only'))
        document.querySelectorAll('.merge-only').forEach(r => r.classList.toggle('hidden', mode === 'own_only'))
    }

    chrome.storage.local.get(['mode', 'myCalendars', 'hideNotMine', 'detectedEmail'], s => {
        const mode = s.mode || 'merge'
        if (!s.mode) chrome.storage.local.set({ 'mode': mode });
        setDropdown('select_mode', mode)
        setText('my_calendars', s.myCalendars || '')
        if (s.detectedEmail) document.getElementById('my_calendars').placeholder = `auto: ${s.detectedEmail}`
        setToggle('toggle_hide_not_mine', !!s.hideNotMine)
        updateRows(mode)
    });

    document.getElementById('select_mode').onchange = function (e) {
        chrome.storage.local.set({ 'mode': e.target.value });
        updateRows(e.target.value)
    };

    document.getElementById('my_calendars').onchange = function (e) {
        chrome.storage.local.set({ 'myCalendars': e.target.value.trim() });
    };

    document.getElementById('toggle_hide_not_mine').onchange = function (e) {
        chrome.storage.local.set({ 'hideNotMine': e.target.checked });
    };

    const manifest_data = chrome.runtime.getManifest();
    document.getElementById('version').innerHTML=`V${manifest_data.version}`

    document.getElementById('toggle_enabled').onclick = function () {
        getDisabled().then(disabled => {
            chrome.storage.local.set({ 'disabled': !disabled });
            setIcon(!disabled);
        })
    };

    document.getElementById('select_style').onchange = function (e) {
        chrome.storage.local.set({ 'style': e.target.value });
    };

    document.getElementById('wildcard_value').onchange = function (e) {
        if (e.target.value.length < 3 && e.target.value !== '') return alert('wildcard too short, you are going to get problems. If you do not want wildcard matching make this textbox blank')
        chrome.storage.local.set({ 'wildcard': e.target.value });
    };
}