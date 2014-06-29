var Tilepin = module.exports = require('./Tilepin');
var _ = require('underscore');

Tilepin.Carto = Tilepin.Carto || {};

/** This object is used to transform JSON object to a CartoCSS styles */
Tilepin.Carto.Serializer = {

    /**
     * This method transforms the specified JSON object into a CartoCSS string
     */
    serialize : function(css) {
        var result = '';
        _.each(css, function(value, key) {
            if (_.isString(value)) {
                var obj = {};
                obj[key] = value;
                result += this._serializeValues('', '', obj)
            } else {
                result += key + ' {\n';
                result += this._serializeValues('  ', '', value);
                result += '}\n';
            }
            // result += '\n';
        }, this);
        return result;
    },

    /**
     * Serializes the specified JSON node using the given shift and prefixes.
     */
    _serializeValues : function(shift, prefix, css) {
        if (!prefix)
            prefix = '';
        var result = '';
        var that = this;
        _.each(css, function(value, key) {
            if (_.isObject(value)) {
                result += shift + prefix + key + ' {\n'
                result += that._serializeValues(shift + '  ', '', value);
                result += shift + '}\n';
            } else {
                result += shift + prefix + key + ': ' + value + ';\n';
            }
        })
        return result;
    },
}
