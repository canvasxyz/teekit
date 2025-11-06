#!/bin/bash
# Script to dump kettle logs to console for debugging

sleep 15
while true; do
    echo "========== KETTLE LOG =========="
    if [ -f /var/log/kettle.log ]; then
        tail -50 /var/log/kettle.log
    else
        echo "No kettle.log found"
    fi
    echo "========== KETTLE ERROR LOG =========="
    if [ -f /var/log/kettle-error.log ]; then
        tail -50 /var/log/kettle-error.log
    else
        echo "No kettle-error.log found"
    fi
    echo "===================================="
    sleep 15
done
