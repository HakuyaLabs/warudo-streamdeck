/// <reference path="libs/js/stream-deck.js" />
/// <reference path="libs/js/action.js" />
/// <reference path="libs/js/utils.js" />

/* GLOBALS */

const MCONTEXTS = [];
const MPLUGINDATA = {
    runningApps: []
};

/** ACTION  related */

const triggerAction = new Action('warudo.trigger');
const toggleAction = new Action('warudo.toggle');
const messageAction = new Action('warudo.message');
console.log('triggerAction', triggerAction);
console.log('toggleAction', toggleAction);
console.log('messageAction', messageAction);
const actions = [triggerAction, toggleAction, messageAction];
const toggleActionInstances = [];

let receivers = [];
let receiverNames = {}; // context -> receiver name
let messages = {}; // context -> message
let toggleStates = {}; // receiver name -> state

const warudoEndpoint = 'ws://localhost:19069';
// Always try to keep the websocket connection open
let ws = null;
// Always try to keep the websocket connection open
setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        setupWebsocket();
    }
}, 1000);

const setupWebsocket = () => {
    toggleStates = {};
    ws = new WebSocket(warudoEndpoint);
    ws.onopen = function() {
        console.log('Connected to Warudo');
        ws.send(JSON.stringify({action: 'getToggles'}));
    }
    ws.onclose = function() {
        console.log('Disconnected from Warudo');
        setupWebsocket();
    }
    ws.onmessage = function(msg) {
        console.log('Message from Warudo', msg);
        const data = JSON.parse(msg.data);
        if (data.action === 'getReceivers') {
            receivers = data.data;
            console.log('getReceivers', receivers);
            MCONTEXTS.forEach(context => {
                sendToPropertyInspector(context, {receivers: receivers});
            });
        } else if (data.action === 'toggle') {
            const { receiverName, state, isResponse } = data.data;
            console.log('toggle', receiverName, state);
            toggleStates[receiverName] = state;
            if (!isResponse) updateToggleStates();
        } else if (data.action === 'getToggles') {
            toggleStates = data.data;
            console.log('getToggles', toggleStates);
            updateToggleStates();
        }
    }
}
setupWebsocket();

const updateToggleStates = () => {
    // Find all toggle actions and update their state
    toggleActionInstances.forEach(context => {
        getSettingsAndRun(context, () => {
            const receiverName = receiverNames[context];
            $SD.setState(context, toggleStates[receiverName] === true ? 1 : 0);
        });
    });
}

setInterval(updateToggleStates, 500);

const pendingActions = {};

const getSettingsAndRun = (context, action) => {
    $SD.getSettings(context);
    pendingActions[context] = action;
}

const sendToPropertyInspector = (context, payload = null) => {
    if(typeof context != 'string') {
        console.error('A key context is required to sendToPropertyInspector.');
    }

    $SD.send(context, Events.sendToPropertyInspector, {
        payload,
    });
}

actions.forEach(action => {
    let actionType;
    if (action === triggerAction) {
        actionType = 'trigger';
    } else if (action === toggleAction) {
        actionType = 'toggle';
    } else if (action === messageAction) {
        actionType = 'message';
    }

    action.onWillAppear(({context, payload}) => {
        console.log('onWillAppear', context, payload);
        if(!MCONTEXTS.includes(context)) MCONTEXTS.push(context);
        if (action === toggleAction) {
            toggleActionInstances.push(context);
        }
        console.log('MCONTEXTS', MCONTEXTS);
    });

    action.onWillDisappear(({context, payload}) => {
        console.log('onWillDisappear', context, payload);
        if(MCONTEXTS.includes(context)) MCONTEXTS.splice(MCONTEXTS.indexOf(context), 1);
        if (action === toggleAction) {
            toggleActionInstances.splice(toggleActionInstances.indexOf(context), 1);
        }
        console.log('MCONTEXTS', MCONTEXTS);
    });

    action.onKeyDown(async jsn => {
        console.log('onKeyDown', jsn.context);
        getSettingsAndRun(jsn.context, () => {
            const data = {
                receiverName: receiverNames[jsn.context],
            };
            if (action === messageAction) {
                data.message = messages[jsn.context] || '';
            }
            const payload = { action: actionType, data }
            console.log('Sending payload', payload)
            ws.send(JSON.stringify(payload));
        });
    });

    action.onKeyUp(jsn => {
        console.log('onKeyUp', jsn.context);
    });

    action.onPropertyInspectorDidAppear(jsn => {
        console.log('onPropertyInspectorDidAppear', jsn.context);
        // the action parameter is not used, but still reuqired by the SDK... we'll remove it in a future release //+++Todo
        // $SD.sendToPropertyInspector(jsn.context, 'com.elgato.pisamples.action', {runningApps: MPLUGINDATA.runningApps});
        sendToPropertyInspector(jsn.context, {receivers: receivers});
    });

    action.onPropertyInspectorDidDisappear(jsn => {
        console.log('onPropertyInspectorDidDisappear', jsn.context);
    });

    action.onDidReceiveSettings(({context, payload}) => {
        console.log('onDidReceiveSettings', context, payload);
        receiverNames[context] = payload.settings.receiverName;
        messages[context] = payload.settings.message;

        if (pendingActions[context]) {
            pendingActions[context]();
            delete pendingActions[context];
        }
    });

    // Here we receive the payload from the property inspector
    action.onSendToPlugin(({context, payload}) => {
        console.log('onSendToPlugin', context, payload);
        if (payload && payload.getReceivers) {
            console.log('getReceivers', payload.getReceivers);
            ws.send(JSON.stringify({ action: 'getReceivers', data: { type: payload.getReceivers } }));
        }
        updateToggleStates();
    });

});

/* STREAMDECK RELATED */

// In this example, we're monitoring a couple of apps
// that we've added to the manifest.json file
// under the "monitoredApps" key
// if one of the monitored apps is launched or terminated,
// we'll update the key images and send the running apps list
// to the property inspector

$SD.onApplicationDidLaunch((jsn) => {
    const {event, payload} = jsn;
    console.log('onApplicationDidLaunch', jsn, event, payload);
    // our monitored app settings (in manifest.json) are case-sensitive
    // so we need to capitalize the app name to match
    const app = Utils.capitalize(Utils.getApplicationName(payload));
    // there should be a corresponding image in the images folder
    const img = `images/${payload.application}.png`;
    // try to load it
    Utils.loadImagePromise(img).then(results => {
        MCONTEXTS.forEach(c => updateKeyImages(c, img));
    });
    // add the monitored app to our running apps list
    if(!MPLUGINDATA.runningApps.includes(app)) {MPLUGINDATA.runningApps.push(app);};
    // send the running apps list to the property inspector
    MCONTEXTS.forEach(updateRunningApps);
});

$SD.onApplicationDidTerminate(({context,payload}) => {
    console.log('onApplicationDidTerminate', payload, payload.application);
    // our monitored app settings (in manifest.json) are case-sensitive
    // so we need to capitalize the app name to match
    const app = Utils.capitalize(Utils.getApplicationName(payload));
    // remove the terminated app from our running apps list
    MPLUGINDATA.runningApps = MPLUGINDATA.runningApps.filter(item => item !== app);
    // there should be a corresponding image in the images folder
    const img = `images/${payload.application}.png`;
    // overlay our terminated image on top of the terminated app image
    const arrImages = [img, 'images/terminated.png'];
    // try to load them
    Utils.loadImages(arrImages).then(images => {
        // if successfully loaded, merge them
        Utils.mergeImages(images).then(b64 => {
            // and update the key images
            MCONTEXTS.forEach(c => updateKeyImages(c, b64));
            setTimeout(() => {
                // after 1.5 seconds, reset the key images
                MCONTEXTS.forEach(c => updateKeyImages(c, `images/default.png`));
            }, 1500);
        });
    });
    // update the running apps list in the property inspector
    MCONTEXTS.forEach(updateRunningApps);
});

/** HELPERS */

const updateRunningApps = (context) => {
    console.log('updateRunningApps', MPLUGINDATA.runningApps);
    // $SD.sendToPropertyInspector(context, {runningApps: MPLUGINDATA.runningApps});
    sendToPropertyInspector(context, {runningApps: MPLUGINDATA.runningApps});
};

const updateKeyImages = (context, url) => {
    // console.log('updateKeyImages', context);
    $SD.setImage(context, url);
};


/** UTILITIES USED IN THIS DEMO */

Utils.loadImagePromise = url =>
    new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({url, img, status: 'ok'});
        img.onerror = () => resolve({url, img, status: 'error'});
        img.src = url;
    });

Utils.loadImages = arrayOfUrls => Promise.all(arrayOfUrls.map(Utils.loadImagePromise));

Utils.capitalize = str => {
    return str.charAt(0).toUpperCase() + str.slice(1);
};

Utils.getApplicationName = (payload) => {
    const isMac = $SD.appInfo.application.platform === 'mac';
    if(payload && payload.application) {
        return isMac ? payload.application.split('.').pop() : payload.application.split('.')[0];
    }
    return '';
};

Utils.mergeImages = (images = [], options = {width: 144, height: 144, format: 'image/png', quality: 1}, inCanvas) => new Promise(resolve => {
    const canvas = inCanvas && inCanvas instanceof HTMLCanvasElement
        ? inCanvas
        : document.createElement('canvas');

    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';

    resolve(Promise.all(images).then(images => {
        canvas.width = options.width || 144;
        canvas.height = options.height || 144;

        // Draw images to canvas
        images.forEach(image => {
            ctx.globalAlpha = image.opacity ? image.opacity : 1;
            return ctx.drawImage(image.img, image.x || 0, image.y || 0);
        });

        // Resolve all other data URIs sync
        return canvas.toDataURL(options.format, options.quality);
    }));
});


