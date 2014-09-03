var Tilepin = module.exports = require('./Tilepin');
require('./Tilepin.IO');
require('./Tilepin.ProjectConfig');
require('./Tilepin.Reloader');

var Mosaic = require('mosaic-commons');
require('mosaic-teleport');

var _ = require('underscore');
var FS = require('fs');
var Path = require('path');

/**
 * This class is used to load and manage server-side server stubs automatically
 * handling requests and delegating them to local service scripts.
 */
Tilepin.ServiceStubProvider = Mosaic.Teleport.ApiDispatcher.extend({

    /** Initializes this instance. */
    initialize : function(options) {
        var that = this;
        var init = Mosaic.Teleport.ApiDispatcher.prototype.initialize;
        init.apply(that, arguments);
        if (!that.options.path) {
            throw Mosaic.Errors.newError('Path prefix is not defined.').code(
                    400);
        }
        if (!that.options.dir) {
            throw Mosaic.Errors.newError('Root folder is not defined.').code(
                    404);
        }
        that._serviceLoader = new Tilepin.Reloader(require);
    },

    /** Loads a server-side endpoint used to handle requests */
    _loadEndpoint : function(path) {
        var that = this;
        return Mosaic.P.then(function() {
            var info = that._getServiceFileInfo(path);
            if (!info)
                return;
            return Mosaic.P.then(function() {
                var service = that._serviceLoader.load(info.file);
                if (_.isFunction(service)) {
                    return service(that.options);
                } else {
                    return service;
                }
            }).then(function(service) {
                if (!service)
                    return;
                return {
                    path : info.path,
                    instance : service
                };
            });
        });
    },

    /**
     * Cleans up the server stub corresponding to the specified source key
     */
    removeEndpoint : function(path) {
        var that = this;
        return Mosaic.P.then(function() {
            var info = that._getServiceFileInfo(path);
            if (info) {
                that._serviceLoader.uncache(info.file);
            }
            return Mosaic.Teleport.ApiDispatcher.prototype.removeEndpoint.call(that,
                    path);
        });
    },

    /**
     * Returns a full file path to the service script corresponding to the given
     * source key.
     */
    _getServiceFileInfo : function(path) {
        var result;
        var that = this;
        var pathPrefix = that.options.path || '';
        if (pathPrefix) {
            path = path.substring(pathPrefix.length);
        }
        var array = path.split('\/');
        while (!result && array.length) {
            var p = array.join('/');
            var file = Path.join(that.options.dir, p);
            file = Path.join(file, 'service.js');
            if (FS.existsSync(file)) {
                result = {
                    file : file,
                    path : pathPrefix + p
                }
                break;
            }
            array.pop();
        }
        return result;
    },

    /**
     * Creates and returns a new server stub providing remote access to the
     * given service instance.
     */
    _newServerStub : function(options) {
        var that = this;
        var serverOptions = _.extend({}, that.options, options, {
            beginHttpCall : function(params) {
                // Get the session ID from the request header
                var sessionId = params.req.get('x-session-id');
                if (sessionId) {
                    // Put the content of the session ID in the query;
                    // So this value became available to API instance
                    // methods.
                    params.req.query.sessionId = sessionId;
                }
            },
            endHttpCall : function(params) {
                var sessionId = params.result ? params.result.sessionId : null;
                if (sessionId) {
                    // Set a sessionId header
                    params.res.set('x-session-id', sessionId);
                    // params.res.cookie(''x-session-id', sessionId);
                }
            },
        });
        var parent = Mosaic.Teleport.ApiDispatcher.prototype;
        var handler = parent._newServerStub.call(that, serverOptions);
        return handler;
    }
});
