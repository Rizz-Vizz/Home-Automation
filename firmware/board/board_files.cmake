mcux_add_configuration(
    CC "-DSDK_DEBUGCONSOLE=0"
    CX "-DSDK_DEBUGCONSOLE=0"
)

mcux_add_source(
    SOURCES
        frdmmcxn236/board.c
        frdmmcxn236/board.h
        frdmmcxn236/clock_config.c
        frdmmcxn236/clock_config.h
        frdmmcxn236/FreeRTOSConfigBoard.h
        pin_mux.c
        pin_mux.h
        app.h
        hardware_init.c
)

mcux_add_include(
    INCLUDES
        .
        frdmmcxn236
)
