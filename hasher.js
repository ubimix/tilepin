//http://www.boronine.com/2012/08/30/Strong-Password-Hashing-with-Node-Standard-Library/
var crypto = require('crypto');

var hasher = function(opts, callback) {
    var _ref;
    if (!opts.plaintext) {
        return crypto.randomBytes(6, function(err, buf) {
            if (err) {
                callback(err);
            }
            opts.plaintext = buf.toString('base64');
            return hasher(opts, callback);
        });
    }
    if (!opts.salt) {
        return crypto.randomBytes(64, function(err, buf) {
            if (err) {
                callback(err);
            }
            opts.salt = buf;
            return hasher(opts, callback);
        });
    }
    opts.hash = 'sha1';
    opts.iterations = (_ref = opts.iterations) != null ? _ref : 10000;
    return crypto.pbkdf2(opts.plaintext, opts.salt, opts.iterations, 6, function(err, key) {
        if (err) {
            callback(err);
        }
        opts.key = new Buffer(key);
        return callback(null, opts);
    });
};


module.exports = hasher;