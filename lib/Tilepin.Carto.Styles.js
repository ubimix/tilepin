var Tilepin = module.exports = require('./Tilepin');
var _ = require('underscore');

Tilepin.Carto = Tilepin.Carto || {};
Tilepin.Carto.Styles = Styles;

function Styles(values) {
    values = values || {};
    function styles() {
        var result = {};
        _.each(arguments, function(obj) {
            if (!obj)
                return;
            _.each(obj, function(val, key) {
                var oldValue = result[key];
                if (_.isObject(oldValue) && _.isObject(val)) {
                    val = styles(oldValue, val);
                }
                result[key] = val;
            })
        })
        return result;
    }
    styles.serialize = styles.toString = function() {
        return Styles.serialize(values);
    }
    styles.clone = function() {
        var newValues = JSON.parse(JSON.stringify(values));
        return Styles(newValues);
    }
    styles.add = function() {
        var args = [ values ].concat(_.toArray(arguments));
        values = styles.apply(styles, args);
        return styles;
    }
    styles.set = function() {
        values = styles.apply(styles, arguments);
        return styles;
    }
    styles.range = function(fromZoom, toZoom) {
        var functions = _.toArray(arguments);
        functions.splice(0, 2);
        var delta = 1;
        if (fromZoom > toZoom) {
            delta = -1;
        }
        _.each(functions, function(f) {
            for (var z = fromZoom; true; z += delta) {
                var obj = f(z, fromZoom, toZoom);
                if (obj) {
                    values = styles(values, obj);
                }
                if (z == toZoom)
                    break;
            }
        })
        return styles;
    }
    styles.get = function() {
        return values;
    }
    return styles;
}

/**
 * This method transforms the specified JSON object into a CartoCSS string
 */
Styles.serialize = function serialize(obj, shift, prefix) {
    obj = obj || this;
    shift = shift || '';
    prefix = prefix || ''
    var result = '';
    _.each(obj, function(value, key) {
        if (_.isObject(value)) {
            result += shift + prefix + key + ' {\n'
            result += serialize(value, shift + '  ', '');
            result += shift + '}\n';
        } else {
            result += shift + prefix + key + ': ' + value + ';\n';
        }
    })
    return result;
}

Styles._linear = function(fromVal, toVal, f, getk) {
    return function(zoom, fromZoom, toZoom) {
        var val;
        if (fromZoom == toZoom) {
            val = fromVal;
        } else {
            var k = getk(zoom, fromZoom, toZoom);
            val = (fromVal + k * (toVal - fromVal));
        }
        return f(zoom, val, fromZoom, toZoom);
    }
}

function max(zoom, fromZoom, toZoom) {
    return Math.abs(Math.max(fromZoom, toZoom) - zoom);
}
function min(zoom, fromZoom, toZoom) {
    return Math.abs(Math.min(fromZoom, toZoom) - zoom);
}

// Linear increasing changes
Styles.linear = Styles.linearInc = Styles.inc = function(fromVal, toVal, f) {
    return Styles._linear(fromVal, toVal, f, function(zoom, fromZoom, toZoom) {
        return (zoom - fromZoom) / (toZoom - fromZoom);
    })
}
// Linear decreasing changes
Styles.linearDec = Styles.dec = function(fromVal, toVal, f) {
    return Styles._linear(fromVal, toVal, f, function(zoom, fromZoom, toZoom) {
        return (toZoom - zoom) / (toZoom - fromZoom);
    })
}
Styles._fib = function(pos) {
    var array = Styles._fibArray = Styles._fibArray || [];
    while (array.length <= pos) {
        var b = array.length < 2 ? 0 : array[array.length - 2];
        var a = array.length < 1 ? 1 : array[array.length - 1];
        array.push(a + b);
    }
    return array[pos];
}

// Fibonacci sequence
Styles.fibInc = Styles.fib = function(f) {
    return function(zoom, fromZoom, toZoom) {
        var val = Styles._fib(min(zoom, fromZoom, toZoom));
        return f(zoom, val, fromZoom, toZoom);
    }
}

Styles.fibDec = function(f) {
    return function(zoom, fromZoom, toZoom) {
        var val = Styles._fib(max(zoom, fromZoom, toZoom));
        return f(zoom, val, fromZoom, toZoom);
    }
}

Styles.expInc = Styles.exp = function(n, f) {
    return function(zoom, fromZoom, toZoom) {
        var val = Math.pow(n, max(zoom, fromZoom, toZoom));
        return f(zoom, val, fromZoom, toZoom);
    }
}

Styles.expDec = function(n, f) {
    return function(zoom, fromZoom, toZoom) {
        var val = Math.pow(n, min(zoom, fromZoom, toZoom));
        return f(zoom, val, fromZoom, toZoom);
    }
}
