var Tilepin = module.exports = {}
Tilepin.Class = Class;
var _ = require('underscore');

/** A simple class definition. Allows to simply define new subclasses. */
function Class(options) {
    this.initialize(options);
}
_.extend(Class.prototype, {
    /**
     * Sets a new set of options parameters. New values are added/replace
     * already existing ones
     */
    setOptions : function(options) {
        this.options = _.extend({}, this.options, options);
    },
    /** Initializes this object. This method is called by the class constructor. */
    initialize : function(options) {
        this.setOptions(options);
    }
});
var typeCounter = 0;
_.extend(Class, {
    /** This method allows to simply extend this class. */
    extend : function(options) {
        function F() {
            F.Parent.apply(this, arguments);
            this.Type = F;
        }
        F.Parent = this;
        _.extend(F, this);
        _.extend(F.prototype, this.prototype, options);
        F.typeId = typeCounter++;
        return F;
    }
})
