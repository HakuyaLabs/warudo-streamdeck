/// <reference path="libs/js/stream-deck.js" />
/// <reference path="libs/js/action.js" />

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
let ws = null;
let _tryconnect = undefined;

const setupWebsocket = () => {
    toggleStates = {};
    ws = new WebSocket(warudoEndpoint);
    ws.onopen = function() {
        console.log('Connected to Warudo');
        ws.send(JSON.stringify({action: 'getToggles'}));
    }
    ws.onclose = function() {
        console.log('Disconnected from Warudo');
        if (_tryconnect) {
            try_connect();
        }
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

const try_connect = () => {
    _tryconnect = window.setTimeout(() => {
        setupWebsocket();
    }, 1000);
}

const cancel_try_connect = () => {
    window.clearTimeout(_tryconnect);
    _tryconnect = undefined;
}

const connecting = () => {
    return (ws) && (ws.readyState == WebSocket.CONNECTING);
}

const connected = () => {
    return (!connecting()) && (ws && (ws.readyState === WebSocket.OPEN));
}

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
            try {
                const data = {
                    receiverName: receiverNames[jsn.context],
                };
                if (action === messageAction) {
                    data.message = messages[jsn.context] || '';
                }

                if (!connected()) {
                    $SD.showAlert(jsn.context);
                    return;
                }

                const payload = { action: actionType, data }
                console.log('Sending payload', payload);
                ws.send(JSON.stringify(payload));
                $SD.showOk(jsn.context);
            } catch (e) {
                $SD.showAlert(jsn.context);
            }
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

$SD.onApplicationDidLaunch((jsn) => {
    const {event, payload} = jsn;
    console.log('Warudo is open, attempting to connect...', jsn, event, payload);
    if (!connected()) {
        try_connect();
    }
});

$SD.onApplicationDidTerminate(({context,payload}) => {
    console.log('Warudo has quit, stopping any attempts at connecting...', payload, payload.application);
    cancel_try_connect();
});
