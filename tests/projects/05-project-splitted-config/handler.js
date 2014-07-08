module.exports = {
    _toUpperCase : function(str) {
        if (!str)
            return '';
        return str.toUpperCase();
    },
    getKey : function(params) {
        var value = this._toUpperCase(params.q);
        return value;
    },

    prepareConfig : function() {
        // options.params - parameters
        // options.config - project configuration
        // options.project - the project instance
    },

    prepareDatasource : function(options) {
        // options.params - parameters
        // options.config - project configuration
        // options.dataLayer - the current data layer to handle
        // options.project - the project instance
        var params = options.params;
        options.dataLayer.Datasource.q = this._toUpperCase(params.q);
    }
}