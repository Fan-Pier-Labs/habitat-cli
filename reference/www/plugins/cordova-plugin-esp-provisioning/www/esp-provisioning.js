cordova.define("cordova-plugin-esp-provisioning.esp-provisioning", function(require, exports, module) {
/**
 *  esp-provisioning.js
 *
 */

var argscheck = require('cordova/argscheck'),
    exec = require('cordova/exec');

/**
 * @callback successCallback
 * @param {Result[]} results
 */

/**
 * @callback errorCallback
 * @param {number} errorCode
 */

var EspProvisioning = {
    ERR_INVALID_PARAMETER: 0,
    ERR_JSON_EXCEPTION: 1,
    ERR_UNKNOWN_EXCEPTION: 2,
    ERR_INVALID_KEY: 3,
    ERR_PERMISSION_DENIED: 4,
    ERR_INVALID_PERIPHERAL: 5,
    ERR_BLUETOOTH_EXCEPTION: 6,
    ERR_PROVISIONING_FAILED: 7,
    /**
     * Start scan
     * @param {string} prefix Device Name Prefix
     * @param {successCallback} successCallback Success callback
     * @param {errorCallback} errorCallback Error callback
     */
    startScan: function (prefix, successCallback, errorCallback) {
        argscheck.checkArgs('SFF', 'EspProvisioning.startScan', arguments);
        prefix = prefix == null ? '' : '' + prefix;
        exec(successCallback, errorCallback, 'EspProvisioning', 'startScan', [prefix]);
    },
    /**
     * Stop scan
     */
    stopScan: function () {
        exec(function () { }, function () { }, 'EspProvisioning', 'stopScan', []);
    },
    /**
     * connect device
     */
    connect: function (bleId, successCallback, errorCallback) {
        exec(successCallback, errorCallback, 'EspProvisioning', 'connect', [bleId]);
    },
    /**
     * scan Wifi List
     */
    scanWifiList: function (successCallback, errorCallback) {
        exec(successCallback, errorCallback, 'EspProvisioning', 'scanWifiList', []);
    },
    /**
     * Configure device
     * @param {string|number} bleId Bluetooth Device Identifier
     * @param {string} apSsid AP SSID
     * @param {string} apPassword AP Password
     * @param {successCallback} successCallback Success callback
     * @param {errorCallback} errorCallback Error callback
     */
    configure: function (bleId, apSsid, apPassword, successCallback, errorCallback) {
        argscheck.checkArgs('***FF', 'EspProvisioning.configure', arguments);
        bleId = bleId == null ? '' : bleId;
        apSsid = apSsid == null ? '' : '' + apSsid;
        apPassword = apPassword == null ? '' : '' + apPassword;
        exec(successCallback, errorCallback, 'EspProvisioning', 'configure', [bleId, apSsid, apPassword]);
    },
    /**
     * Read RSSI
     * @param {string|number} bleId Bluetooth Device Identifier
     * @param {successCallback} successCallback Success callback
     * @param {errorCallback} errorCallback Error callback
     */
    readRSSI: function (bleId, successCallback, errorCallback) {
        argscheck.checkArgs('*FF', 'EspProvisioning.readRSSI', arguments);
        bleId = bleId == null ? '' : bleId;
        exec(successCallback, errorCallback, 'EspProvisioning', 'readRSSI', [bleId]);
    },
    /**
     * disconnect
     */
    disconnect: function () {
        exec(function () { }, function () { }, 'EspProvisioning', 'disconnect', []);
    },
    /**
     * Watch bluetooth state status
     * @param {successCallback} successCallback 
     * @param {errorCallback} errorCallback 
     */
    watchBluetoothState: function (successCallback, errorCallback) {
        argscheck.checkArgs('FF', 'EspProvisioning.watchBluetoothState', arguments);
        exec(successCallback, errorCallback, 'EspProvisioning', 'watchBluetoothState', []);
    },
    /**
     * Clear Bluetooth state monitoring
     */
    clearWatchBluetoothState: function () {
        exec(function () { }, function () { }, 'EspProvisioning', 'clearWatchBluetoothState', []);
    },
};

// global cordova, module
module.exports = EspProvisioning;

});
