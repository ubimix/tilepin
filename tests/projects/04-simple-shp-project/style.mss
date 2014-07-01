@water: #E0FFFF;
@land: 	#FFFFFF;
@border: gray;

Map { /* the ocean */
    background-color: @water;
}

#country-shapes-110m {
    line-width: 1;
    line-color: @border;
    polygon-fill: @land;
}
