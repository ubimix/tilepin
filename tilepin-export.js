/** Map export in various formats (PNG, JPG, SVG, PDF...) */
var Path = require('path')
var FS = require('fs');
var Commons = require('./tilepin-commons');
var P = Commons.P;
var _ = require('underscore');
module.exports = MapExport;

/**
 * 
 */
function MapExport(options) {
    this.options = options || {};
}
_.extend(MapExport.prototype, {})
