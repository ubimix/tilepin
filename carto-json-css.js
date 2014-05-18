(function(context, _) {
    context.CartoCssSerializer = CartoCssSerializer;

    function CartoCssSerializer() {
    }

    CartoCssSerializer.prototype = {

        serialize : function(css) {
            var result = '';
            _.each(css, function(value, key) {
                result += this._serializeStyle(key, value);
                result += '\n\n';
            }, this);
            return result;
        },

        _serializeValues : function(shift, prefix, css) {
            if (!prefix)
                prefix = '';
            var result = '';
            var that = this;
            _.each(css, function(value, key) {
                if (_.isObject(value)) {
                    // if (key.indexOf('[') >= 0) {
                    result += shift + prefix + key + ' {\n'
                    result += that._serializeValues(shift + '  ', '', value);
                    result += shift + '}\n';
                    // } else {
                    // result += that
                    // ._serializeValues(shift, key + '/', value);
                    // }
                } else {
                    result += shift + prefix + key + ': ' + value + ';\n';
                }
            })
            return result;
        },

        _serializeStyle : function(name, css) {
            var result = '';
            if (_.isString(css)) {
                var obj = {};
                obj[name] = css;
                result += this._serializeValues('  ', '', obj)
            } else {
                result += name + ' {\n';
                result += this._serializeValues('  ', '', css);
                result += '}';
            }
            return result;
        }
    }

})((module && module.exports) ? module.exports : this,
        (require ? require('underscore') : null) || _);
